/**
 * @description State-machine based Salesforce Debug Log Parser.
 * Parses raw ApexLog body strings and extracts execution transactions, DML steps,
 * trigger contexts, flow elements, SOQL metrics, exceptions, and governor limits.
 * Implements ILogParser for enterprise pluggability.
 * 
 * @author Senior Salesforce Architect
 * @date 2026-07-31
 */
public with sharing class DebugLogParser implements ILogParser {

    /**
     * @description Parser state machine states
     */
    public enum ParserState {
        IDLE,
        INSIDE_DML,
        INSIDE_FLOW,
        INSIDE_TRIGGER,
        INSIDE_SOQL,
        INSIDE_EXCEPTION
    }

    // --- Log Event Constants ---
    public static final String EVENT_CODE_UNIT_STARTED       = 'CODE_UNIT_STARTED';
    public static final String EVENT_CODE_UNIT_FINISHED      = 'CODE_UNIT_FINISHED';
    public static final String EVENT_FLOW_START_INTERVIEW    = 'FLOW_START_INTERVIEW';
    public static final String EVENT_FLOW_ELEMENT_BEGIN      = 'FLOW_ELEMENT_BEGIN';
    public static final String EVENT_FLOW_ELEMENT_END        = 'FLOW_ELEMENT_END';
    public static final String EVENT_FLOW_BULK_ELEMENT_BEGIN = 'FLOW_BULK_ELEMENT_BEGIN';
    public static final String EVENT_FLOW_BULK_ELEMENT_END   = 'FLOW_BULK_ELEMENT_END';
    public static final String EVENT_FLOW_VALUE_ASSIGNMENT   = 'FLOW_VALUE_ASSIGNMENT';
    public static final String EVENT_VALIDATION_RULE         = 'VALIDATION_RULE';
    public static final String EVENT_SOQL_EXECUTE_BEGIN      = 'SOQL_EXECUTE_BEGIN';
    public static final String EVENT_SOQL_EXECUTE_END        = 'SOQL_EXECUTE_END';
    public static final String EVENT_DML_BEGIN               = 'DML_BEGIN';
    public static final String EVENT_DML_END                 = 'DML_END';
    public static final String EVENT_EXCEPTION_THROWN        = 'EXCEPTION_THROWN';
    public static final String EVENT_FATAL_ERROR             = 'FATAL_ERROR';
    public static final String EVENT_LIMIT_USAGE_FOR_NS      = 'LIMIT_USAGE_FOR_NS';
    public static final String EVENT_CUMULATIVE_LIMIT_USAGE  = 'CUMULATIVE_LIMIT_USAGE';
    public static final String EVENT_SYSTEM_METHOD_ENTRY    = 'SYSTEM_METHOD_ENTRY';
    public static final String EVENT_SYSTEM_METHOD_EXIT     = 'SYSTEM_METHOD_EXIT';
    public static final String EVENT_VALIDATION_EXCEPTION    = 'FIELD_CUSTOM_VALIDATION_EXCEPTION';
    public static final String EVENT_REQUIRED_FIELD_MISSING  = 'REQUIRED_FIELD_MISSING';

    /**
     * @description Data structure representing a single parsed log line
     */
    public class LogLine {
        public String rawLine;
        public String timestamp;
        public String eventType;
        public String details;
        public List<String> parts;

        public LogLine(String line) {
            this.rawLine = line;
            parseLine(line);
        }

        private void parseLine(String line) {
            if (String.isBlank(line)) {
                return;
            }
            List<String> lineParts = line.split('\\|');
            this.parts = lineParts;
            if (!lineParts.isEmpty()) {
                String firstPart = lineParts[0].trim();
                Integer spaceIndex = firstPart.indexOf(' ');
                this.timestamp = spaceIndex > 0 ? firstPart.substring(0, spaceIndex) : firstPart;

                if (lineParts.size() > 1) {
                    this.eventType = lineParts[1].trim();
                }
                if (lineParts.size() > 2) {
                    List<String> detailParts = new List<String>();
                    for (Integer i = 2; i < lineParts.size(); i++) {
                        detailParts.add(lineParts[i]);
                    }
                    this.details = String.join(detailParts, ' | ');
                } else {
                    this.details = line;
                }
            }
        }
    }

    /**
     * @description Context accumulator used during state machine log parsing
     */
    public class ParserContext {
        public ApexLog logRecord;
        public ParserState currentState;
        public List<ParserState> stateStack;
        public List<DebugLogController.DebugTransactionWrapper> transactions;
        public DebugLogController.DebugTransactionWrapper activeTransaction;
        public List<DebugLogController.TimelineEntry> pendingTimeline;
        public DebugLogController.GovernorLimitsWrapper governorLimits;
        public String activeParentStep;
        public Integer sequenceCounter;

        public ParserContext(ApexLog logRecord) {
            this.logRecord = logRecord;
            this.currentState = ParserState.IDLE;
            this.stateStack = new List<ParserState>();
            this.transactions = new List<DebugLogController.DebugTransactionWrapper>();
            this.pendingTimeline = new List<DebugLogController.TimelineEntry>();
            this.governorLimits = new DebugLogController.GovernorLimitsWrapper();
            this.sequenceCounter = 0;
            this.activeParentStep = 'System';
        }

        public void pushState(ParserState newState) {
            this.stateStack.add(this.currentState);
            this.currentState = newState;
        }

        public void popState() {
            if (!this.stateStack.isEmpty()) {
                this.currentState = this.stateStack.remove(this.stateStack.size() - 1);
            } else {
                this.currentState = ParserState.IDLE;
            }
        }

        public Integer nextSequence() {
            this.sequenceCounter++;
            return this.sequenceCounter;
        }

        public DebugLogController.DebugTransactionWrapper startDmlTransaction(String objectApiName, String operation, String timestamp) {
            DebugLogController.DebugTransactionWrapper txn = new DebugLogController.DebugTransactionWrapper();
            String logId = logRecord == null ? 'UNKNOWN' : logRecord.Id;
            Integer index = this.transactions.size() + 1;
            txn.Id = logId + '-DML-' + index;
            txn.DebugLogId = logId;
            txn.transactionId = 'LOG-' + logId + '-DML-' + index;
            txn.objectApiName = String.isBlank(objectApiName) ? 'Unknown' : objectApiName;
            txn.operation = String.isBlank(operation) ? 'Update' : operation;
            txn.dmlType = txn.operation;
            txn.userName = logRecord != null && logRecord.LogUser != null ? logRecord.LogUser.Name : UserInfo.getName();
            txn.triggeredBy = txn.userName;
            txn.triggeredById = logRecord != null ? logRecord.LogUserId : UserInfo.getUserId();
            txn.status = 'Success';
            txn.startTime = logRecord != null ? logRecord.StartTime : Datetime.now();
            txn.endTime = txn.startTime;
            txn.totalDurationMs = 0;
            txn.duration = '0 ms';
            txn.IsDebugLog = true;
            txn.timeline = new List<DebugLogController.TimelineEntry>();
            txn.dmlEvents = new List<DebugLogController.DmlEventWrapper>();
            txn.triggerEvents = new List<DebugLogController.TriggerEventWrapper>();
            txn.flowEvents = new List<DebugLogController.FlowEventWrapper>();
            txn.soqlEvents = new List<DebugLogController.SoqlEventWrapper>();
            txn.exceptions = new List<DebugLogController.ExceptionEventWrapper>();
            txn.governorLimits = this.governorLimits;

            // Attach prior pending timeline entries (e.g. Trigger start before DML_BEGIN)
            if (!this.pendingTimeline.isEmpty()) {
                for (DebugLogController.TimelineEntry pendingEntry : this.pendingTimeline) {
                    txn.timeline.add(pendingEntry);
                }
            }

            this.activeTransaction = txn;
            this.transactions.add(txn);
            return txn;
        }

        public void addTimelineEntry(DebugLogController.TimelineEntry entry) {
            if (this.activeTransaction != null) {
                this.activeTransaction.timeline.add(entry);
                this.activeTransaction.totalSteps = this.activeTransaction.timeline.size();
            } else {
                this.pendingTimeline.add(entry);
            }
        }

        public void markFailure(String errorMessage) {
            if (this.activeTransaction != null) {
                this.activeTransaction.status = 'Failed';
                if (String.isBlank(this.activeTransaction.errorMessage)) {
                    this.activeTransaction.errorMessage = errorMessage;
                }
            }
            // Mark all transactions in this log as failed if an unhandled exception occurred
            for (DebugLogController.DebugTransactionWrapper txn : this.transactions) {
                txn.status = 'Failed';
                if (String.isBlank(txn.errorMessage)) {
                    txn.errorMessage = errorMessage;
                }
            }
        }
    }

    /**
     * @description ILogParser interface implementation: Parses log and returns primary transaction wrapper.
     */
    public DebugLogController.DebugTransactionWrapper parse(ApexLog log, String logBody) {
        List<DebugLogController.DebugTransactionWrapper> results = parseAll(log, logBody);
        return results.isEmpty() ? null : results[0];
    }

    /**
     * @description ILogParser interface implementation: Parses log and returns all DML transaction wrappers.
     */
    public List<DebugLogController.DebugTransactionWrapper> parseAll(ApexLog log, String logBody) {
        if (String.isBlank(logBody)) {
            return new List<DebugLogController.DebugTransactionWrapper>();
        }

        ParserContext context = new ParserContext(log);
        List<String> rawLines = logBody.split('\\r?\\n');

        for (String rawLine : rawLines) {
            if (String.isBlank(rawLine)) {
                continue;
            }
            LogLine line = new LogLine(rawLine);
            if (String.isBlank(line.eventType)) {
                continue;
            }
            processLine(context, line);
        }

        // Fallback: If no DML_BEGIN was present, but important log events exist, create a primary summary transaction
        if (context.transactions.isEmpty() && !context.pendingTimeline.isEmpty()) {
            createFallbackTransaction(context);
        }

        return context.transactions;
    }

    /**
     * @description State Machine line processing dispatcher
     */
    private static void processLine(ParserContext context, LogLine line) {
        String eventType = line.eventType;

        if (eventType == EVENT_DML_BEGIN) {
            handleDmlBegin(context, line);
        } else if (eventType == EVENT_DML_END) {
            handleDmlEnd(context, line);
        } else if (eventType == EVENT_CODE_UNIT_STARTED) {
            handleCodeUnitStarted(context, line);
        } else if (eventType == EVENT_CODE_UNIT_FINISHED) {
            handleCodeUnitFinished(context, line);
        } else if (eventType.startsWith('FLOW_')) {
            handleFlowEvent(context, line);
        } else if (eventType == EVENT_SOQL_EXECUTE_BEGIN) {
            handleSoqlBegin(context, line);
        } else if (eventType == EVENT_SOQL_EXECUTE_END) {
            handleSoqlEnd(context, line);
        } else if (eventType == EVENT_VALIDATION_RULE) {
            handleValidationRule(context, line);
        } else if (eventType == EVENT_EXCEPTION_THROWN || eventType == EVENT_FATAL_ERROR ||
                   eventType == EVENT_VALIDATION_EXCEPTION || eventType == EVENT_REQUIRED_FIELD_MISSING) {
            handleException(context, line);
        } else if (eventType == EVENT_LIMIT_USAGE_FOR_NS || eventType == EVENT_CUMULATIVE_LIMIT_USAGE) {
            handleLimitUsage(context, line);
        } else if (eventType == EVENT_SYSTEM_METHOD_ENTRY || eventType == EVENT_SYSTEM_METHOD_EXIT) {
            handleSystemMethod(context, line);
        }
    }

    private static void handleDmlBegin(ParserContext context, LogLine line) {
        context.pushState(ParserState.INSIDE_DML);
        String operation = normalizeDml(extractDebugValue(line.details, 'Op'));
        String objectApiName = extractDebugValue(line.details, 'Type');
        String rowsStr = extractDebugValue(line.details, 'Rows');

        DebugLogController.DebugTransactionWrapper txn = context.startDmlTransaction(objectApiName, operation, line.timestamp);

        DebugLogController.DmlEventWrapper dmlEvt = new DebugLogController.DmlEventWrapper();
        dmlEvt.operation = txn.operation;
        dmlEvt.objectApiName = txn.objectApiName;
        dmlEvt.rowsAffected = String.isBlank(rowsStr) ? 1 : Integer.valueOf(rowsStr);
        dmlEvt.timestamp = line.timestamp;
        txn.dmlEvents.add(dmlEvt);

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'DML';
        entry.label = 'DML Begin (' + txn.operation + ' ' + txn.objectApiName + ')';
        entry.details = line.details;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.objectApiName = txn.objectApiName;
        entry.operation = txn.operation;
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
    }

    private static void handleDmlEnd(ParserContext context, LogLine line) {
        if (context.activeTransaction != null) {
            DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
            entry.sequence = context.nextSequence();
            entry.type = 'DML';
            entry.label = 'DML End (' + context.activeTransaction.operation + ' ' + context.activeTransaction.objectApiName + ')';
            entry.details = line.details;
            entry.timestamp = line.timestamp;
            entry.status = context.activeTransaction.status;
            entry.objectApiName = context.activeTransaction.objectApiName;
            entry.operation = context.activeTransaction.operation;
            entry.parentStep = context.activeParentStep;
            context.addTimelineEntry(entry);
        }
        context.popState();
    }

    private static void handleCodeUnitStarted(ParserContext context, LogLine line) {
        context.pushState(ParserState.INSIDE_TRIGGER);
        String details = line.details;
        String componentName = extractCodeUnitName(details);
        String entryType = extractCodeUnitType(details);
        String phase = extractTriggerPhase(details);
        context.activeParentStep = componentName;

        if (context.activeTransaction != null) {
            DebugLogController.TriggerEventWrapper trig = new DebugLogController.TriggerEventWrapper();
            trig.name = componentName;
            trig.type = entryType;
            trig.timestamp = line.timestamp;
            trig.eventPhase = phase;
            context.activeTransaction.triggerEvents.add(trig);
        }

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = entryType.contains('Trigger') ? 'Trigger' : 'Code Unit';
        entry.label = entryType + ': ' + componentName;
        entry.details = details;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = componentName;
        entry.eventPhase = phase;
        context.addTimelineEntry(entry);
    }

    private static void handleCodeUnitFinished(ParserContext context, LogLine line) {
        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'Code Unit';
        entry.label = 'Code Unit Finished (' + context.activeParentStep + ')';
        entry.details = line.details;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
        context.popState();
    }

    private static void handleFlowEvent(ParserContext context, LogLine line) {
        context.pushState(ParserState.INSIDE_FLOW);
        String eventType = line.eventType;
        String label = 'Flow Event (' + cleanDebugMarker(eventType) + ')';
        String flowName = extractFlowName(line.details);
        Boolean isError = eventType.contains('ERROR');

        if (context.activeTransaction != null) {
            DebugLogController.FlowEventWrapper flowEvt = new DebugLogController.FlowEventWrapper();
            flowEvt.flowName = flowName;
            flowEvt.elementName = extractFlowElement(line.details);
            flowEvt.eventType = eventType;
            flowEvt.status = isError ? 'Failed' : 'Success';
            flowEvt.timestamp = line.timestamp;
            context.activeTransaction.flowEvents.add(flowEvt);
        }

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'Flow';
        entry.label = label;
        entry.details = line.details;
        entry.timestamp = line.timestamp;
        entry.status = isError ? 'Failed' : 'Success';
        entry.parentStep = flowName;
        context.addTimelineEntry(entry);

        if (isError) {
            context.markFailure(cleanDebugDetail(line.details));
        }
    }

    private static void handleSoqlBegin(ParserContext context, LogLine line) {
        context.pushState(ParserState.INSIDE_SOQL);
        String details = line.details;
        String queryText = extractSoqlQuery(details);

        if (context.activeTransaction != null) {
            DebugLogController.SoqlEventWrapper soqlEvt = new DebugLogController.SoqlEventWrapper();
            soqlEvt.query = queryText;
            soqlEvt.timestamp = line.timestamp;
            context.activeTransaction.soqlEvents.add(soqlEvt);
        }

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'SOQL';
        entry.label = 'SOQL Execute Begin';
        entry.details = queryText;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
    }

    private static void handleSoqlEnd(ParserContext context, LogLine line) {
        String rowsStr = extractDebugValue(line.details, 'Rows');
        Integer rows = String.isBlank(rowsStr) ? 0 : Integer.valueOf(rowsStr);

        if (context.activeTransaction != null && !context.activeTransaction.soqlEvents.isEmpty()) {
            DebugLogController.SoqlEventWrapper lastSoql = context.activeTransaction.soqlEvents[context.activeTransaction.soqlEvents.size() - 1];
            lastSoql.rowsReturned = rows;
        }

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'SOQL';
        entry.label = 'SOQL Execute End (Rows: ' + rows + ')';
        entry.details = line.details;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);

        context.popState();
    }

    private static void handleValidationRule(ParserContext context, LogLine line) {
        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'Validation';
        entry.label = 'Validation Rule Evaluated';
        entry.details = line.details;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
    }

    private static void handleException(ParserContext context, LogLine line) {
        context.pushState(ParserState.INSIDE_EXCEPTION);
        String errorMsg = left(cleanDebugDetail(line.details), 255);
        context.markFailure(errorMsg);

        if (context.activeTransaction != null) {
            DebugLogController.ExceptionEventWrapper exc = new DebugLogController.ExceptionEventWrapper();
            exc.exceptionType = line.eventType;
            exc.message = errorMsg;
            exc.timestamp = line.timestamp;
            context.activeTransaction.exceptions.add(exc);
        }

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'Exception';
        entry.label = 'Exception: ' + line.eventType;
        entry.details = errorMsg;
        entry.timestamp = line.timestamp;
        entry.status = 'Failed';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
    }

    private static void handleLimitUsage(ParserContext context, LogLine line) {
        parseGovernorLimits(context.governorLimits, line.details);

        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'Limits';
        entry.label = line.eventType == EVENT_LIMIT_USAGE_FOR_NS ? 'Limit Usage (NS)' : 'Cumulative Limit Usage';
        entry.details = line.details;
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
    }

    private static void handleSystemMethod(ParserContext context, LogLine line) {
        DebugLogController.TimelineEntry entry = new DebugLogController.TimelineEntry();
        entry.sequence = context.nextSequence();
        entry.type = 'System Method';
        entry.label = line.eventType == EVENT_SYSTEM_METHOD_ENTRY ? 'System Method Entry' : 'System Method Exit';
        entry.details = cleanDebugDetail(line.details);
        entry.timestamp = line.timestamp;
        entry.status = 'Success';
        entry.parentStep = context.activeParentStep;
        context.addTimelineEntry(entry);
    }

    private static void createFallbackTransaction(ParserContext context) {
        ApexLog logRecord = context.logRecord;
        DebugLogController.DebugTransactionWrapper txn = new DebugLogController.DebugTransactionWrapper();
        String logId = logRecord == null ? 'UNKNOWN' : logRecord.Id;
        txn.Id = logId;
        txn.DebugLogId = logId;
        txn.transactionId = 'LOG-' + logId;
        txn.objectApiName = 'System';
        txn.operation = 'Execution';
        txn.dmlType = txn.operation;
        txn.userName = logRecord != null && logRecord.LogUser != null ? logRecord.LogUser.Name : UserInfo.getName();
        txn.triggeredBy = txn.userName;
        txn.triggeredById = logRecord != null ? logRecord.LogUserId : UserInfo.getUserId();
        txn.status = logRecord != null && logRecord.Status == 'Success' ? 'Success' : 'Failed';
        txn.startTime = logRecord != null ? logRecord.StartTime : Datetime.now();
        txn.endTime = txn.startTime;
        txn.totalDurationMs = 0;
        txn.duration = '0 ms';
        txn.IsDebugLog = true;
        txn.timeline = context.pendingTimeline;
        txn.totalSteps = txn.timeline.size();
        txn.dmlEvents = new List<DebugLogController.DmlEventWrapper>();
        txn.triggerEvents = new List<DebugLogController.TriggerEventWrapper>();
        txn.flowEvents = new List<DebugLogController.FlowEventWrapper>();
        txn.soqlEvents = new List<DebugLogController.SoqlEventWrapper>();
        txn.exceptions = new List<DebugLogController.ExceptionEventWrapper>();
        txn.governorLimits = context.governorLimits;
        context.transactions.add(txn);
    }

    // --- Helper Utility Methods ---

    public static Boolean matchesFilter(
        DebugLogController.DebugTransactionWrapper txn,
        String objectName,
        String status,
        String dmlType,
        Date startDate,
        Date endDate,
        String userName
    ) {
        if (txn == null) {
            return false;
        }
        if (!String.isBlank(objectName) && objectName != 'All' && !objectName.equalsIgnoreCase(txn.objectApiName)) {
            return false;
        }
        if (!String.isBlank(status) && status != 'All' && !status.equalsIgnoreCase(txn.status)) {
            return false;
        }
        if (!String.isBlank(dmlType) && dmlType != 'All' && !dmlType.equalsIgnoreCase(txn.dmlType) && !dmlType.equalsIgnoreCase(txn.operation)) {
            return false;
        }
        if (!String.isBlank(userName) && userName != 'All' && txn.userName != null && !txn.userName.toLowerCase().contains(userName.toLowerCase())) {
            return false;
        }
        if (startDate != null && txn.startTime != null && txn.startTime.date() < startDate) {
            return false;
        }
        if (endDate != null && txn.startTime != null && txn.startTime.date() > endDate) {
            return false;
        }
        return true;
    }

    private static String extractDebugValue(String text, String key) {
        if (String.isBlank(text)) {
            return null;
        }
        Pattern valPattern = Pattern.compile(key + ':\\s*([^|\\s]+)');
        Matcher matcher = valPattern.matcher(text);
        return matcher.find() ? matcher.group(1).trim() : null;
    }

    private static String extractCodeUnitName(String details) {
        if (String.isBlank(details)) {
            return 'Code Unit';
        }
        Matcher triggerMatcher = Pattern.compile('__sfdc_trigger/([^:|]+)').matcher(details);
        if (triggerMatcher.find()) {
            return triggerMatcher.group(1);
        }
        Matcher apexMatcher = Pattern.compile('apex://([^:|]+)').matcher(details);
        if (apexMatcher.find()) {
            return apexMatcher.group(1);
        }
        return cleanDebugDetail(details);
    }

    private static String extractTriggerPhase(String details) {
        if (String.isBlank(details)) return null;
        String lower = details.toLowerCase();
        if (lower.contains('beforeinsert')) return 'Before Insert';
        if (lower.contains('afterinsert')) return 'After Insert';
        if (lower.contains('beforeupdate')) return 'Before Update';
        if (lower.contains('afterupdate')) return 'After Update';
        if (lower.contains('beforedelete')) return 'Before Delete';
        if (lower.contains('afterdelete')) return 'After Delete';
        if (lower.contains('afterundelete')) return 'After Undelete';
        return null;
    }

    private static String extractCodeUnitType(String details) {
        if (String.isBlank(details)) {
            return 'Code Unit';
        }
        if (details.contains('__sfdc_trigger')) return 'Trigger';
        if (details.contains('Flow')) return 'Flow';
        if (details.contains('Batch')) return 'Batch Apex';
        if (details.contains('Queueable')) return 'Queueable Apex';
        if (details.contains('Future')) return 'Future Apex';
        return 'Apex';
    }

    private static String extractFlowName(String details) {
        if (String.isBlank(details)) {
            return 'Flow';
        }
        Matcher matcher = Pattern.compile('(?:Interview Label|Flow):\\s*([^|]+)').matcher(details);
        return matcher.find() ? matcher.group(1).trim() : cleanDebugDetail(details);
    }

    private static String extractFlowElement(String details) {
        if (String.isBlank(details)) {
            return 'Flow Element';
        }
        Matcher matcher = Pattern.compile('FLOW_ELEMENT_BEGIN\\|[^|]+\\|[^|]+\\|([^|]+)').matcher(details);
        return matcher.find() ? matcher.group(1).trim() : 'Flow Action';
    }

    private static String extractSoqlQuery(String details) {
        if (String.isBlank(details)) {
            return 'SOQL Query';
        }
        Matcher matcher = Pattern.compile('SELECT\\s+.+').matcher(details);
        return matcher.find() ? matcher.group(0) : cleanDebugDetail(details);
    }

    private static void parseGovernorLimits(DebugLogController.GovernorLimitsWrapper limits, String details) {
        if (limits == null || String.isBlank(details)) {
            return;
        }
        Matcher soqlMatcher = Pattern.compile('Number of SOQL queries:\\s*(\\d+)\\s*out of\\s*(\\d+)').matcher(details);
        if (soqlMatcher.find()) {
            limits.soqlQueries = Integer.valueOf(soqlMatcher.group(1));
            limits.maxSoqlQueries = Integer.valueOf(soqlMatcher.group(2));
        }
        Matcher dmlMatcher = Pattern.compile('Number of DML statements:\\s*(\\d+)\\s*out of\\s*(\\d+)').matcher(details);
        if (dmlMatcher.find()) {
            limits.dmlStatements = Integer.valueOf(dmlMatcher.group(1));
            limits.maxDmlStatements = Integer.valueOf(dmlMatcher.group(2));
        }
        Matcher cpuMatcher = Pattern.compile('Maximum CPU time:\\s*(\\d+)\\s*out of\\s*(\\d+)').matcher(details);
        if (cpuMatcher.find()) {
            limits.cpuTimeMs = Integer.valueOf(cpuMatcher.group(1));
            limits.maxCpuTimeMs = Integer.valueOf(cpuMatcher.group(2));
        }
        Matcher heapMatcher = Pattern.compile('Maximum heap size:\\s*(\\d+)\\s*out of\\s*(\\d+)').matcher(details);
        if (heapMatcher.find()) {
            limits.heapSizeBytes = Integer.valueOf(heapMatcher.group(1));
            limits.maxHeapSizeBytes = Integer.valueOf(heapMatcher.group(2));
        }
    }

    private static String normalizeDml(String value) {
        if (String.isBlank(value)) {
            return 'Update';
        }
        String lower = value.toLowerCase();
        if (lower == 'insert') return 'Insert';
        if (lower == 'update') return 'Update';
        if (lower == 'delete') return 'Delete';
        if (lower == 'undelete') return 'Undelete';
        if (lower == 'merge') return 'Merge';
        return value;
    }

    private static String cleanDebugMarker(String marker) {
        if (String.isBlank(marker)) {
            return 'Debug Event';
        }
        return marker.replace('_', ' ');
    }

    private static String cleanDebugDetail(String details) {
        if (String.isBlank(details)) {
            return '-';
        }
        return details.replaceAll('\\s+', ' ').trim();
    }

    private static String left(String value, Integer maxLength) {
        if (value == null || value.length() <= maxLength) {
            return value;
        }
        return value.substring(0, maxLength);
    }
}

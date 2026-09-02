/**
 * @description Controller backing the LWC DML Transaction Visualizer.
 * Executes SOQL-first filter queries on ApexLog (scanning logs for confirmed DML_BEGIN lines, UI record saves, triggers, and execution contexts),
 * fetches debug log bodies using Tooling API, and delegates parsing to client/parser implementations.
 * 
 * @author Senior Salesforce Architect
 * @date 2026-08-06
 */
public with sharing class DebugLogController {
    private static final Integer RECENT_LOG_SCAN_LIMIT = 25;
    private static final Integer MAX_FETCHABLE_LOG_BYTES = 5000000;
    private static final Set<String> INTERNAL_DML_OBJECTS = new Set<String>{
        'TXN_LOG_EVENT__E',
        'TXN_STEP_LOG_EVENT__E',
        'TXN_FIELD_CHANGE_EVENT__E',
        'TXN_LOG_EVENT__C',
        'TXN_STEP__C',
        'TXN_FIELD_CHANGE__C',
        'APEXLOG',
        'ASYNCAPEXJOB',
        'TRACEFLAG',
        'DEBUGLEVEL',
        'DEBUGLOGCONTROLLER',
        'DMLTRANSACTIONVISUALIZERAPEX'
    };

    public class LogWrapper {
        @AuraEnabled public String Id;
        @AuraEnabled public String Operation;
        @AuraEnabled public String Status;
        @AuraEnabled public String StartTime;
        @AuraEnabled public String LogUserName;
        @AuraEnabled public Integer LogLength;
        @AuraEnabled public String Request;
        @AuraEnabled public String Application;
        @AuraEnabled public String RawBody;
        @AuraEnabled public Integer DmlIndex;
        @AuraEnabled public String DmlObjectName;
        @AuraEnabled public String DmlType;
        @AuraEnabled public Integer DmlRows;
        @AuraEnabled public String DmlTimestamp;
        @AuraEnabled public Long DmlStartNanos;
        @AuraEnabled public Long DmlEndNanos;
        @AuraEnabled public Boolean IsDmlSummary;
        @AuraEnabled public String IndexStatus;
        @AuraEnabled public String DmlSummaryJson;
        @AuraEnabled public String LogUserId;
    }

    public class QueueResponse {
        @AuraEnabled public List<LogWrapper> indexedLogs = new List<LogWrapper>();
        @AuraEnabled public List<LogWrapper> pendingLogs = new List<LogWrapper>();
        @AuraEnabled public List<LogWrapper> blockedLogs = new List<LogWrapper>();
    }

    private class DmlSummary {
        String objectName;
        String operation;
        Integer rows;
        String timestamp;
        Long startNanos;
        Long endNanos;
    }

    public class TimelineEntry {
        @AuraEnabled public Integer sequence;
        @AuraEnabled public String type;
        @AuraEnabled public String label;
        @AuraEnabled public String timestamp;
        @AuraEnabled public String details;
        @AuraEnabled public Long duration;
        @AuraEnabled public String status;
        @AuraEnabled public String objectApiName;
        @AuraEnabled public String operation;
        @AuraEnabled public String parentStep;
        @AuraEnabled public String eventPhase;
    }

    public class DmlEventWrapper {
        @AuraEnabled public String operation;
        @AuraEnabled public String objectApiName;
        @AuraEnabled public Integer rowsAffected;
        @AuraEnabled public String timestamp;
    }

    public class TriggerEventWrapper {
        @AuraEnabled public String name;
        @AuraEnabled public String type;
        @AuraEnabled public String timestamp;
        @AuraEnabled public String eventPhase;
    }

    public class FlowEventWrapper {
        @AuraEnabled public String flowName;
        @AuraEnabled public String elementName;
        @AuraEnabled public String eventType;
        @AuraEnabled public String status;
        @AuraEnabled public String timestamp;
    }

    public class SoqlEventWrapper {
        @AuraEnabled public String query;
        @AuraEnabled public Integer rowsReturned;
        @AuraEnabled public String timestamp;
    }

    public class GovernorLimitsWrapper {
        @AuraEnabled public Integer soqlQueries = 0;
        @AuraEnabled public Integer maxSoqlQueries = 100;
        @AuraEnabled public Integer dmlStatements = 0;
        @AuraEnabled public Integer maxDmlStatements = 150;
        @AuraEnabled public Integer cpuTimeMs = 0;
        @AuraEnabled public Integer maxCpuTimeMs = 10000;
        @AuraEnabled public Integer heapSizeBytes = 0;
        @AuraEnabled public Integer maxHeapSizeBytes = 6000000;
    }

    public class ExceptionEventWrapper {
        @AuraEnabled public String exceptionType;
        @AuraEnabled public String message;
        @AuraEnabled public String timestamp;
    }

    public class DebugTransactionWrapper {
        @AuraEnabled public String Id;
        @AuraEnabled public String DebugLogId;
        @AuraEnabled public String transactionId;
        @AuraEnabled public String objectApiName;
        @AuraEnabled public String dmlType;
        @AuraEnabled public String operation;
        @AuraEnabled public String triggeredBy;
        @AuraEnabled public String userName;
        @AuraEnabled public String triggeredById;
        @AuraEnabled public String status;
        @AuraEnabled public Integer totalSteps;
        @AuraEnabled public Integer totalDurationMs;
        @AuraEnabled public String duration;
        @AuraEnabled public Datetime startTime;
        @AuraEnabled public Datetime endTime;
        @AuraEnabled public String recordIds;
        @AuraEnabled public String errorMessage;
        @AuraEnabled public Boolean IsDebugLog;

        @AuraEnabled public List<TimelineEntry> timeline;
        @AuraEnabled public List<DmlEventWrapper> dmlEvents;
        @AuraEnabled public List<TriggerEventWrapper> triggerEvents;
        @AuraEnabled public List<FlowEventWrapper> flowEvents;
        @AuraEnabled public List<SoqlEventWrapper> soqlEvents;
        @AuraEnabled public GovernorLimitsWrapper governorLimits;
        @AuraEnabled public List<ExceptionEventWrapper> exceptions;
    }

    /**
     * @description Returns recent business-object DML summaries. Full log bodies are
     * intentionally fetched only when the user selects a queue row.
     */
    @AuraEnabled
    public static List<LogWrapper> getRecentDmlLogs() {
        return getQueueLogs().pendingLogs;
    }

    @AuraEnabled
    public static QueueResponse getQueueLogs() {
        Id currentUserId = UserInfo.getUserId();
        QueueResponse response = new QueueResponse();
        List<ApexLog> recentLogs = [
            SELECT Id, Operation, Status, StartTime, LogUserId, LogUser.Name,
                   LogLength, Request, Application
            FROM ApexLog
            WHERE LogUserId = :currentUserId
            ORDER BY StartTime DESC
            LIMIT :RECENT_LOG_SCAN_LIMIT
        ];
        for (ApexLog log : recentLogs) {
            if (isToolingApiNoise(log)) {
                continue;
            }
            response.pendingLogs.add(queueWrapper(log));
        }
        return response;
    }

    /**
     * @description Public method matching existing LWC contract
     */
    @AuraEnabled
    public static List<DebugTransactionWrapper> getAnalyzedRecentDmlLogs(String objectName, String status, String dmlType, Integer limitCount) {
        return getAnalyzedRecentDmlLogsWithFilters(objectName, status, dmlType, null, null, null, limitCount);
    }

    /**
     * @description Extended method supporting Date range and User filtering with SOQL-first optimization
     */
    @AuraEnabled
    public static List<DebugTransactionWrapper> getAnalyzedRecentDmlLogsWithFilters(
        String objectName,
        String status,
        String dmlType,
        Date startDate,
        Date endDate,
        String userName,
        Integer limitCount
    ) {
        Integer safeLimit = limitCount == null || limitCount <= 0 || limitCount > 50 ? 25 : limitCount;
        List<DebugTransactionWrapper> result = new List<DebugTransactionWrapper>();

        Id currentUserId = UserInfo.getUserId();
        String query = 'SELECT Id, Operation, Status, StartTime, LogUserId, LogUser.Name, LogLength, Request, Application FROM ApexLog WHERE LogUserId = :currentUserId ';

        if (!String.isBlank(status) && status != 'All') {
            query += ' AND Status = :status ';
        }
        if (startDate != null) {
            Datetime startDt = Datetime.newInstance(startDate.year(), startDate.month(), startDate.day(), 0, 0, 0);
            query += ' AND StartTime >= :startDt ';
        }
        if (endDate != null) {
            Datetime endDt = Datetime.newInstance(endDate.year(), endDate.month(), endDate.day(), 23, 59, 59);
            query += ' AND StartTime <= :endDt ';
        }
        if (!String.isBlank(userName) && userName != 'All') {
            String userPattern = '%' + userName + '%';
            query += ' AND LogUser.Name LIKE :userPattern ';
        }
        query += ' ORDER BY StartTime DESC LIMIT 40';

        List<ApexLog> logs = Database.query(query);
        ILogParser parser = new DebugLogParser();

        for (ApexLog log : logs) {
            if (isToolingApiNoise(log)) {
                continue;
            }
            if (result.size() >= safeLimit) {
                break;
            }
            String body;
            try {
                body = fetchLogBodyInternal(log.Id);
            } catch (Exception ex) {
                continue;
            }

            List<DebugTransactionWrapper> parsedTransactions = parser.parseAll(log, body);
            for (DebugTransactionWrapper summary : parsedTransactions) {
                if (summary == null) {
                    continue;
                }
                if (!DebugLogParser.matchesFilter(summary, objectName, status, dmlType, startDate, endDate, userName)) {
                    continue;
                }
                result.add(summary);
                if (result.size() >= safeLimit) {
                    break;
                }
            }
        }
        return result;
    }

    @AuraEnabled
    public static List<DebugTransactionWrapper> parseLog(String logId) {
        if (String.isBlank(logId)) {
            throw new AuraHandledException('Log Id is required.');
        }
        Id currentUserId = UserInfo.getUserId();
        List<ApexLog> logs = [
            SELECT Id, Operation, Status, StartTime, LogUserId, LogUser.Name, LogLength
            FROM ApexLog
            WHERE Id = :logId
              AND LogUserId = :currentUserId
            LIMIT 1
        ];
        if (logs.isEmpty()) {
            return new List<DebugTransactionWrapper>();
        }
        String body = fetchLogBodyInternal(logId);
        ILogParser parser = new DebugLogParser();
        return parser.parseAll(logs[0], body);
    }

    @AuraEnabled
    public static String fetchLogBody(String logId) {
        if (String.isBlank(logId)) {
            throw new AuraHandledException('Log Id is required.');
        }

        Id currentUserId = UserInfo.getUserId();
        List<ApexLog> accessibleLogs = [
            SELECT Id, LogLength
            FROM ApexLog
            WHERE Id = :logId
              AND LogUserId = :currentUserId
            LIMIT 1
        ];
        if (accessibleLogs.isEmpty()) {
            throw new AuraHandledException('Debug log was not found for the current user.');
        }
        if (accessibleLogs[0].LogLength != null && accessibleLogs[0].LogLength > MAX_FETCHABLE_LOG_BYTES) {
            throw new AuraHandledException('LOG_TOO_LARGE: This debug log is too large for interactive parsing.');
        }

        try {
            return fetchLogBodyInternal(logId);
        } catch (CalloutException ex) {
            throw new AuraHandledException('Unable to fetch debug log body. Check the DML_Tooling Named Credential. ' + ex.getMessage());
        }
    }

    private static Boolean isToolingApiNoise(ApexLog log) {
        return false;
    }

    private static LogWrapper queueWrapper(ApexLog log) {
        LogWrapper wrapper = new LogWrapper();
        wrapper.Id = log.Id;
        wrapper.Operation = log.Operation;
        wrapper.Status = log.Status;
        wrapper.StartTime = String.valueOf(log.StartTime);
        wrapper.LogUserName = log.LogUser == null ? null : log.LogUser.Name;
        wrapper.LogUserId = String.valueOf(log.LogUserId);
        wrapper.LogLength = log.LogLength;
        wrapper.Request = log.Request;
        wrapper.Application = log.Application;
        wrapper.IsDmlSummary = false;
        wrapper.IndexStatus = 'Pending';
        wrapper.DmlSummaryJson = null;
        return wrapper;
    }

    private static List<DmlSummary> extractBusinessDmlSummaries(String body) {
        List<DmlSummary> summaries = new List<DmlSummary>();
        if (String.isBlank(body)) {
            return summaries;
        }

        List<DmlSummary> openDml = new List<DmlSummary>();
        for (String line : body.split('\\r?\\n')) {
            if (String.isBlank(line)) {
                continue;
            }
            List<String> parts = line.split('\\|');
            if (parts.size() < 2) {
                continue;
            }

            String eventType = parts[1].trim();
            if (eventType == 'DML_BEGIN') {
                DmlSummary summary = new DmlSummary();
                summary.timestamp = parseTimestampString(parts[0]);
                summary.startNanos = parseTimestampNanos(parts[0]);
                for (Integer index = 2; index < parts.size(); index++) {
                    String part = parts[index].trim();
                    if (part.startsWith('Op:')) {
                        summary.operation = part.substringAfter('Op:').trim();
                    } else if (part.startsWith('Type:')) {
                        summary.objectName = part.substringAfter('Type:').trim();
                    } else if (part.startsWith('Rows:')) {
                        summary.rows = parseInteger(part.substringAfter('Rows:').trim(), 1);
                    }
                }
                if (summary.rows == null) {
                    summary.rows = 1;
                }
                openDml.add(summary);
            } else if (eventType == 'DML_END' && !openDml.isEmpty()) {
                Integer lastOpenIndex = openDml.size() - 1;
                DmlSummary summary = openDml[lastOpenIndex];
                openDml.remove(lastOpenIndex);
                summary.endNanos = parseTimestampNanos(parts[0]);
                if (!String.isBlank(summary.objectName) && !isInternalDmlObject(summary.objectName)) {
                    summaries.add(summary);
                }
            }
        }

        for (DmlSummary summary : openDml) {
            if (!String.isBlank(summary.objectName) && !isInternalDmlObject(summary.objectName)) {
                summaries.add(summary);
            }
        }
        return summaries;
    }

    private static Boolean isInternalDmlObject(String objectName) {
        String normalized = String.valueOf(objectName).trim().toUpperCase();
        return INTERNAL_DML_OBJECTS.contains(normalized) ||
            normalized.startsWith('APEX') ||
            normalized.startsWith('AURA') ||
            normalized.endsWith('EVENT__E');
    }

    private static String parseTimestampString(String timestampPart) {
        if (String.isBlank(timestampPart)) {
            return '-';
        }
        String value = timestampPart.trim();
        Integer spaceIndex = value.indexOf(' ');
        String timeValue = spaceIndex >= 0 ? value.substring(0, spaceIndex) : value;
        Integer dotIndex = timeValue.indexOf('.');
        return dotIndex >= 0 ? timeValue.substring(0, dotIndex) : timeValue;
    }

    private static Long parseTimestampNanos(String timestampPart) {
        if (String.isBlank(timestampPart)) {
            return null;
        }
        Integer openIndex = timestampPart.indexOf('(');
        Integer closeIndex = timestampPart.indexOf(')', openIndex);
        if (openIndex < 0 || closeIndex <= openIndex + 1) {
            return null;
        }
        return parseLong(timestampPart.substring(openIndex + 1, closeIndex));
    }

    private static Integer parseInteger(String value, Integer fallbackValue) {
        try {
            return Integer.valueOf(value);
        } catch (Exception ex) {
            return fallbackValue;
        }
    }

    private static Long parseLong(String value) {
        try {
            return Long.valueOf(value);
        } catch (Exception ex) {
            return null;
        }
    }

    private static String fetchLogBodyInternal(String logId) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint('callout:DML_Tooling/services/data/v67.0/tooling/sobjects/ApexLog/' + EncodingUtil.urlEncode(logId, 'UTF-8') + '/Body');
        request.setMethod('GET');
        request.setTimeout(120000);

        HttpResponse response = new Http().send(request);
        if (response.getStatusCode() >= 200 && response.getStatusCode() < 300) {
            return response.getBody();
        }
        throw new AuraHandledException('Unable to fetch debug log body. Status ' + response.getStatusCode() + ': ' + response.getBody());
    }

    private static DebugTransactionWrapper analyzeLog(ApexLog log, String body) {
        ILogParser parser = new DebugLogParser();
        return parser.parse(log, body);
    }
}
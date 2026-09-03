public without sharing class DMLTransactionVisualizerApex {
    private static final Set<String> SKIPPED_FIELDS = new Set<String>{
        'Id', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById',
        'SystemModstamp', 'IsDeleted', 'LastViewedDate', 'LastReferencedDate'
    };

    private static String transactionId;
    private static String objectName;
    private static String dmlType;
    private static String status = 'Success';
    private static String errorMessage;
    private static Long transactionStart;
    private static Long transactionEnd;
    private static Integer sequenceNumber = 0;
    private static TXNStepWrapper currentStep;
    private static List<TXNStepWrapper> steps = new List<TXNStepWrapper>();
    private static List<TXNFieldChangeWrapper> allFieldChanges = new List<TXNFieldChangeWrapper>();
    private static Map<Id, SObject> oldRecords;
    private static Map<Id, SObject> newRecords;
    private static String recordIds;
    private static Boolean published = false;

    public class DemoException extends Exception {}
    public class RequiredFieldException extends Exception {}

    public class TXNFieldChangeWrapper {
        public String recordId;
        public String fieldAPIName;
        public String fieldLabel;
        public String oldValue;
        public String newValue;
        public String fieldType;
        public String stepKey;
    }

    public class TXNStepWrapper {
        public String stepKey;
        public String stepName;
        public String stepType;
        public Integer sequenceNumber;
        public String status;
        public String errorMessage;
        public String errorClass;
        public Integer errorLine;
        public String stackTrace;
        public Long startTime;
        public Long endTime;
        public Long durationMs;
        public Integer soqlQueriesUsed;
        public Integer dmlStatementsUsed;
        public Integer cpuTimeUsed;
        public Integer heapSizeUsed;
        public List<TXNFieldChangeWrapper> fieldChanges;
    }

    public class TransactionDetail {
        @AuraEnabled public TXN_Log__c log;
        @AuraEnabled public List<TXN_Step__c> steps;
        @AuraEnabled public Map<Id, List<TXN_Field_Change__c>> changesByStepId;
    }

    public class PicklistOption {
        @AuraEnabled public String label;
        @AuraEnabled public String value;

        public PicklistOption(String label, String value) {
            this.label = label;
            this.value = value;
        }
    }

    public class FlowLogRequest {
        @InvocableVariable(label='Flow Name')
        public String flowName;

        @InvocableVariable(label='Flow Element')
        public String flowElement;

        @InvocableVariable(label='Object API Name')
        public String objectName;

        @InvocableVariable(label='Record Id')
        public String recordId;

        @InvocableVariable(label='DML Type')
        public String dmlType;

        @InvocableVariable(label='Status')
        public String status;

        @InvocableVariable(label='Message')
        public String message;

        @InvocableVariable(label='Error Message')
        public String errorMessage;
    }

    @AuraEnabled
    public static List<TXN_Log__c> getTransactions(String objectName, String status, String dmlType, Integer limitCount) {
        try {
            Integer safeLimit = limitCount == null || limitCount <= 0 || limitCount > 200 ? 50 : limitCount;
            Integer queryLimit = Math.max(safeLimit, 500);
            List<TXN_Log__c> rows = [
                SELECT Id, Name, Transaction_Id__c, Object_API_Name__c, DML_Type__c, Triggered_By__c,
                       Triggered_By_Id__c, Status__c, Total_Steps__c, Total_Duration_ms__c,
                       Error_Message__c, Start_Time__c, End_Time__c, Record_Ids__c
                FROM TXN_Log__c
                WHERE Start_Time__c != null
                AND Total_Steps__c > 0
                ORDER BY Start_Time__c DESC NULLS LAST
                LIMIT :queryLimit
            ];
            List<TXN_Log__c> filtered = new List<TXN_Log__c>();
            for (TXN_Log__c row : rows) {
                if (!String.isBlank(objectName) && objectName != 'All' && row.Object_API_Name__c != objectName) continue;
                if (!String.isBlank(status) && status != 'All' && row.Status__c != status) continue;
                if (!String.isBlank(dmlType) && dmlType != 'All' && row.DML_Type__c != dmlType) continue;
                filtered.add(row);
                if (filtered.size() >= safeLimit) {
                    break;
                }
            }
            return filtered;
        } catch (Exception ex) {
            throw new AuraHandledException(dataErrorMessage('Loading saved transactions', ex));
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<PicklistOption> getObjectOptions() {
        try {
            List<PicklistOption> options = new List<PicklistOption>{ new PicklistOption('All Objects', 'All') };
            for (AggregateResult resultRow : [
                SELECT Object_API_Name__c objectName
                FROM TXN_Log__c
                WHERE Object_API_Name__c != null
                GROUP BY Object_API_Name__c
                ORDER BY Object_API_Name__c ASC
                LIMIT 200
            ]) {
                String apiName = (String) resultRow.get('objectName');
                options.add(new PicklistOption(apiName, apiName));
            }
            return options;
        } catch (Exception ex) {
            throw new AuraHandledException(dataErrorMessage('Loading transaction object filters', ex));
        }
    }

    @AuraEnabled
    public static TransactionDetail getTransactionDetail(String transactionId) {
        try {
            TransactionDetail detail = new TransactionDetail();
            List<TXN_Log__c> logs = [
                SELECT Id, Name, Transaction_Id__c, Object_API_Name__c, DML_Type__c, Triggered_By__c,
                       Triggered_By_Id__c, Status__c, Total_Steps__c, Total_Duration_ms__c,
                       Error_Message__c, Start_Time__c, End_Time__c, Record_Ids__c
                FROM TXN_Log__c
                WHERE Transaction_Id__c = :transactionId
                LIMIT 1
            ];
            if (logs.isEmpty()) {
                throw new AuraHandledException('Saved transaction not found. It may have been deleted or is no longer available. Refresh the queue and try again.');
            }
            detail.log = logs[0];
            detail.steps = [
                SELECT Id, Name, Step_Key__c, Step_Name__c, Step_Type__c, Sequence_Number__c,
                       Status__c, Error_Message__c, Error_Class__c, Error_Line__c, Stack_Trace__c,
                       Duration_ms__c, Start_Time__c, End_Time__c, SOQL_Queries_Used__c,
                       DML_Statements_Used__c, CPU_Time_Used_ms__c, Heap_Size_Used_bytes__c
                FROM TXN_Step__c
                WHERE TXN_Log__c = :detail.log.Id
                ORDER BY Sequence_Number__c ASC
            ];
            Set<Id> stepIds = new Map<Id, TXN_Step__c>(detail.steps).keySet();
            detail.changesByStepId = new Map<Id, List<TXN_Field_Change__c>>();
            for (TXN_Field_Change__c change : [
                SELECT Id, TXN_Step__c, Record_Id__c, Field_API_Name__c, Field_Label__c,
                       Old_Value__c, New_Value__c, Field_Type__c
                FROM TXN_Field_Change__c
                WHERE TXN_Step__c IN :stepIds
                ORDER BY Field_API_Name__c ASC
            ]) {
                if (!detail.changesByStepId.containsKey(change.TXN_Step__c)) {
                    detail.changesByStepId.put(change.TXN_Step__c, new List<TXN_Field_Change__c>());
                }
                detail.changesByStepId.get(change.TXN_Step__c).add(change);
            }
            return detail;
        } catch (Exception ex) {
            if (ex instanceof AuraHandledException) {
                throw (AuraHandledException) ex;
            }
            throw new AuraHandledException(dataErrorMessage('Loading transaction details', ex));
        }
    }

    @AuraEnabled
    public static TXN_Step__c getGovernorLimitSummary(String stepId) {
        try {
            return [
                SELECT Id, SOQL_Queries_Used__c, DML_Statements_Used__c, CPU_Time_Used_ms__c,
                       Heap_Size_Used_bytes__c
                FROM TXN_Step__c
                WHERE Id = :stepId
                LIMIT 1
            ];
        } catch (Exception ex) {
            throw new AuraHandledException(dataErrorMessage('Loading governor-limit details', ex));
        }
    }

    @AuraEnabled
    public static void deleteTransactions(List<String> transactionIds) {
        try {
            if (transactionIds == null || transactionIds.isEmpty()) {
                return;
            }
            Set<String> safeIds = new Set<String>();
            for (String txId : transactionIds) {
                if (!String.isBlank(txId)) {
                    safeIds.add(txId);
                }
            }
            if (safeIds.isEmpty()) {
                return;
            }
            List<TXN_Log__c> logs = [
                SELECT Id
                FROM TXN_Log__c
                WHERE Transaction_Id__c IN :safeIds
                LIMIT 200
            ];
            if (logs.isEmpty()) {
                return;
            }
            Set<Id> logIds = new Map<Id, TXN_Log__c>(logs).keySet();
            List<TXN_Step__c> persistedSteps = [
                SELECT Id
                FROM TXN_Step__c
                WHERE TXN_Log__c IN :logIds
            ];
            if (!persistedSteps.isEmpty()) {
                Set<Id> stepIds = new Map<Id, TXN_Step__c>(persistedSteps).keySet();
                List<String> deleteErrors = new List<String>();
                addDeleteErrors(Database.delete([
                    SELECT Id
                    FROM TXN_Field_Change__c
                    WHERE TXN_Step__c IN :stepIds
                ], false), deleteErrors, 'field changes');
                addDeleteErrors(Database.delete(persistedSteps, false), deleteErrors, 'transaction steps');
                addDeleteErrors(Database.delete(logs, false), deleteErrors, 'transactions');
                if (!deleteErrors.isEmpty()) {
                    throw new AuraHandledException('Some records could not be deleted: ' + String.join(deleteErrors, ' | '));
                }
                return;
            }
            List<String> deleteErrors = new List<String>();
            addDeleteErrors(Database.delete(logs, false), deleteErrors, 'transactions');
            if (!deleteErrors.isEmpty()) {
                throw new AuraHandledException('Some records could not be deleted: ' + String.join(deleteErrors, ' | '));
            }
        } catch (Exception ex) {
            if (ex instanceof AuraHandledException) {
                throw (AuraHandledException) ex;
            }
            throw new AuraHandledException('The selected transactions could not be deleted. Verify object permissions and try again.');
        }
    }

    private static void addDeleteErrors(List<Database.DeleteResult> results, List<String> errors, String recordType) {
        for (Database.DeleteResult result : results) {
            if (result.isSuccess()) {
                continue;
            }
            for (Database.Error deleteError : result.getErrors()) {
                String detail = deleteError.getStatusCode() + ': ' + deleteError.getMessage();
                errors.add(recordType + ' - ' + detail.left(180));
            }
        }
    }

    @InvocableMethod(label='Log DML Transaction Flow Step' description='Logs an explicit Flow step for the DML Transaction Visualizer.')
    public static void logFlowStep(List<FlowLogRequest> requests) {
        try {
            if (requests == null || requests.isEmpty()) {
                return;
            }

            List<TXN_Log_Event__e> logEvents = new List<TXN_Log_Event__e>();
            List<TXN_Step_Log_Event__e> stepEvents = new List<TXN_Step_Log_Event__e>();
            Long nowMillis = System.currentTimeMillis();

            for (Integer index = 0; index < requests.size(); index++) {
                FlowLogRequest request = requests[index];
                String flowTransactionId = createFlowTransactionId(index);
                String normalizedStatus = normalizeStatus(request.status, request.errorMessage);
                String flowObjectName = String.isBlank(request.objectName) ? 'Unknown' : request.objectName;
                String flowDmlType = normalizeDml(request.dmlType);
                String flowName = String.isBlank(request.flowName) ? 'Flow' : request.flowName;
                String elementName = String.isBlank(request.flowElement) ? 'Flow Action' : request.flowElement;
                String message = normalizedStatus == 'Failed' && !String.isBlank(request.errorMessage)
                    ? request.errorMessage
                    : request.message;

                logEvents.add(new TXN_Log_Event__e(
                    Transaction_Id__c = flowTransactionId,
                    Object_API_Name__c = flowObjectName,
                    DML_Type__c = flowDmlType,
                    Triggered_By__c = left(UserInfo.getName(), 100),
                    Triggered_By_Id__c = UserInfo.getUserId(),
                    Status__c = normalizedStatus,
                    Total_Steps__c = 1,
                    Total_Duration_ms__c = 0,
                    Error_Message__c = normalizedStatus == 'Failed' ? left(message, 255) : null,
                    Start_Time__c = String.valueOf(nowMillis),
                    End_Time__c = String.valueOf(nowMillis),
                    Record_Ids__c = left(request.recordId, 255)
                ));

                stepEvents.add(new TXN_Step_Log_Event__e(
                    Transaction_Id__c = flowTransactionId,
                    Step_Key__c = left(flowTransactionId + '-FLOW-1', 80),
                    Step_Name__c = left('Flow: ' + flowName + ' - ' + elementName, 255),
                    Step_Type__c = 'Flow',
                    Sequence_Number__c = 1,
                    Status__c = normalizedStatus,
                    Error_Message__c = normalizedStatus == 'Failed' ? left(message, 255) : null,
                    Error_Class__c = normalizedStatus == 'Failed' ? 'Flow' : null,
                    Duration_ms__c = 0,
                    Start_Time__c = String.valueOf(nowMillis),
                    End_Time__c = String.valueOf(nowMillis),
                    SOQL_Queries_Used__c = Limits.getQueries(),
                    DML_Statements_Used__c = Limits.getDmlStatements(),
                    CPU_Time_Used_ms__c = Limits.getCpuTime(),
                    Heap_Size_Used_bytes__c = Limits.getHeapSize()
                ));
            }

            if (!logEvents.isEmpty()) {
                EventBus.publish(logEvents);
            }
            if (!stepEvents.isEmpty()) {
                EventBus.publish(stepEvents);
            }
        } catch (Exception ex) {
            System.debug('TXNFlowLogger failed: ' + ex.getMessage());
        }
    }

    public static void startTransaction(String objectAPIName, String operationType, Map<Id, SObject> oldMap, Map<Id, SObject> newMap) {
        try {
            if (!String.isBlank(transactionId)) {
                mergeScope(oldMap, newMap);
                recordIds = buildRecordIds(oldRecords, newRecords);
                return;
            }
            transactionId = createTransactionId();
            objectName = objectAPIName;
            dmlType = operationType;
            oldRecords = oldMap == null ? new Map<Id, SObject>() : oldMap;
            newRecords = newMap == null ? new Map<Id, SObject>() : newMap;
            recordIds = buildRecordIds(oldRecords, newRecords);
            status = 'Success';
            errorMessage = null;
            sequenceNumber = 0;
            steps.clear();
            allFieldChanges.clear();
            transactionStart = System.currentTimeMillis();
            published = false;
        } catch (Exception ex) {
            System.debug('TriggerLogger.startTransaction failed: ' + ex.getMessage());
        }
    }

    public static void startStep(String stepName, String stepType) {
        try {
            if (String.isBlank(transactionId)) {
                startTransaction('Unknown', 'Update', null, null);
            }
            sequenceNumber++;
            currentStep = new TXNStepWrapper();
            currentStep.stepKey = transactionId + '-' + sequenceNumber;
            currentStep.stepName = stepName;
            currentStep.stepType = stepType;
            currentStep.sequenceNumber = sequenceNumber;
            currentStep.status = 'Success';
            currentStep.startTime = System.currentTimeMillis();
            currentStep.soqlQueriesUsed = Limits.getQueries();
            currentStep.dmlStatementsUsed = Limits.getDmlStatements();
            currentStep.cpuTimeUsed = Limits.getCpuTime();
            currentStep.heapSizeUsed = Limits.getHeapSize();
            currentStep.fieldChanges = new List<TXNFieldChangeWrapper>();
        } catch (Exception ex) {
            System.debug('TriggerLogger.startStep failed: ' + ex.getMessage());
        }
    }

    public static void endStep() {
        try {
            if (currentStep == null) {
                return;
            }
            currentStep.endTime = System.currentTimeMillis();
            currentStep.durationMs = currentStep.endTime - currentStep.startTime;
            currentStep.soqlQueriesUsed = Limits.getQueries() - currentStep.soqlQueriesUsed;
            currentStep.dmlStatementsUsed = Limits.getDmlStatements() - currentStep.dmlStatementsUsed;
            currentStep.cpuTimeUsed = Limits.getCpuTime() - currentStep.cpuTimeUsed;
            currentStep.heapSizeUsed = Limits.getHeapSize();
            currentStep.fieldChanges = sequenceNumber == 1
                ? captureChanges(oldRecords, newRecords, objectName)
                : new List<TXNFieldChangeWrapper>();
            for (TXNFieldChangeWrapper change : currentStep.fieldChanges) {
                change.stepKey = currentStep.stepKey;
                allFieldChanges.add(change);
            }
            steps.add(currentStep);
            currentStep = null;
        } catch (Exception ex) {
            System.debug('TriggerLogger.endStep failed: ' + ex.getMessage());
        }
    }

    public static void captureError(Exception e) {
        try {
            status = 'Failed';
            errorMessage = e == null ? 'Unknown error' : e.getMessage();
            if (currentStep == null) {
                startStep('AccountTrigger', 'Error');
            }
            currentStep.status = 'Failed';
            currentStep.errorMessage = errorMessage;
            currentStep.errorClass = e == null ? null : e.getTypeName();
            currentStep.errorLine = e == null ? null : e.getLineNumber();
            currentStep.stackTrace = e == null ? null : e.getStackTraceString();
            endStep();
        } catch (Exception ex) {
            System.debug('TriggerLogger.captureError failed: ' + ex.getMessage());
        }
    }

    public static void endTransaction() {
        try {
            if (published || String.isBlank(transactionId)) {
                return;
            }
            transactionEnd = System.currentTimeMillis();
            TXN_Log_Event__e eventValue = new TXN_Log_Event__e(
                Transaction_Id__c = transactionId,
                Object_API_Name__c = objectName,
                DML_Type__c = dmlType,
                Triggered_By__c = left(UserInfo.getName(), 100),
                Triggered_By_Id__c = UserInfo.getUserId(),
                Status__c = status,
                Total_Steps__c = steps.size(),
                Total_Duration_ms__c = transactionEnd - transactionStart,
                Error_Message__c = left(errorMessage, 255),
                Start_Time__c = String.valueOf(transactionStart),
                End_Time__c = String.valueOf(transactionEnd),
                Record_Ids__c = left(recordIds, 255),
                Steps_JSON__c = null,
                Field_Changes_JSON__c = null
            );
            try {
                EventBus.publish(eventValue);
                publishStepEvents();
                publishFieldChangeEvents();
                published = true;
            } catch (Exception publishEx) {
                System.debug('TriggerLogger publish failed: ' + publishEx.getMessage());
            }
        } catch (Exception ex) {
            System.debug('TriggerLogger.endTransaction failed: ' + ex.getMessage());
        } finally {
            reset();
        }
    }

    public static void validateRequiredFields(String objectApiName, List<SObject> newRows, Boolean isInsert, Boolean isUpdate) {
        if (String.isBlank(objectApiName) || newRows == null || newRows.isEmpty()) {
            return;
        }
        Map<String, Schema.SObjectType> typesByName = Schema.getGlobalDescribe();
        if (!typesByName.containsKey(objectApiName)) {
            return;
        }
        Map<String, Schema.SObjectField> fieldsByName = typesByName.get(objectApiName).getDescribe().fields.getMap();
        List<String> missingFields = new List<String>();
        for (SObject row : newRows) {
            for (String fieldName : fieldsByName.keySet()) {
                Schema.DescribeFieldResult fieldDescribe = fieldsByName.get(fieldName).getDescribe();
                if (!isRequiredForDml(fieldName, fieldDescribe, isInsert, isUpdate)) {
                    continue;
                }
                Object value = row.get(fieldName);
                if (value == null || (value instanceof String && String.isBlank((String) value))) {
                    missingFields.add(fieldDescribe.getLabel() + ' (' + fieldName + ')');
                }
            }
        }
        if (!missingFields.isEmpty()) {
            throw new RequiredFieldException(
                'REQUIRED_FIELD_MISSING: Required fields are missing: [' + String.join(missingFields, ', ') + '].'
            );
        }
    }

    public static void handleLogEvents(List<TXN_Log_Event__e> events) {
        try {
            if (events == null || events.isEmpty()) {
                return;
            }
            Set<String> transactionIds = new Set<String>();
            for (TXN_Log_Event__e eventValue : events) {
                if (!String.isBlank(eventValue.Transaction_Id__c)) {
                    transactionIds.add(eventValue.Transaction_Id__c);
                }
            }
            Map<String, TXN_Log__c> existingByTransactionId = new Map<String, TXN_Log__c>();
            if (!transactionIds.isEmpty()) {
                for (TXN_Log__c logRow : [
                    SELECT Id, Transaction_Id__c, Status__c, Total_Steps__c, Error_Message__c
                    FROM TXN_Log__c
                    WHERE Transaction_Id__c IN :transactionIds
                ]) {
                    existingByTransactionId.put(logRow.Transaction_Id__c, logRow);
                }
            }

            List<TXN_Log__c> logs = new List<TXN_Log__c>();
            Map<String, TXN_Log_Event__e> eventByTransactionId = new Map<String, TXN_Log_Event__e>();
            for (TXN_Log_Event__e eventValue : events) {
                if (String.isBlank(eventValue.Transaction_Id__c)) {
                    continue;
                }
                eventByTransactionId.put(eventValue.Transaction_Id__c, eventValue);
                TXN_Log__c existing = existingByTransactionId.get(eventValue.Transaction_Id__c);
                Boolean keepExistingFailure = existing != null
                    && existing.Status__c == 'Failed'
                    && normalizeStatus(eventValue.Status__c) != 'Failed';
                Decimal incomingSteps = eventValue.Total_Steps__c == null ? 0 : eventValue.Total_Steps__c;
                logs.add(new TXN_Log__c(
                    Id = existing?.Id,
                    Transaction_Id__c = eventValue.Transaction_Id__c,
                    Object_API_Name__c = eventValue.Object_API_Name__c,
                    DML_Type__c = normalizeDml(eventValue.DML_Type__c),
                    Triggered_By__c = eventValue.Triggered_By__c,
                    Triggered_By_Id__c = eventValue.Triggered_By_Id__c,
                    Status__c = keepExistingFailure ? existing.Status__c : normalizeStatus(eventValue.Status__c),
                    Total_Steps__c = incomingSteps > 0 ? eventValue.Total_Steps__c : existing?.Total_Steps__c,
                    Total_Duration_ms__c = eventValue.Total_Duration_ms__c,
                    Error_Message__c = String.isBlank(eventValue.Error_Message__c) ? existing?.Error_Message__c : eventValue.Error_Message__c,
                    Start_Time__c = fromMillis(eventValue.Start_Time__c),
                    End_Time__c = fromMillis(eventValue.End_Time__c),
                    Record_Ids__c = eventValue.Record_Ids__c
                ));
            }
            if (logs.isEmpty()) {
                return;
            }
            Database.upsert(logs, TXN_Log__c.Fields.Transaction_Id__c, false);

            Map<String, Id> logIdByTransactionId = new Map<String, Id>();
            for (TXN_Log__c logRow : [
                SELECT Id, Transaction_Id__c
                FROM TXN_Log__c
                WHERE Transaction_Id__c IN :eventByTransactionId.keySet()
            ]) {
                logIdByTransactionId.put(logRow.Transaction_Id__c, logRow.Id);
            }

            List<TXN_Step__c> stepRows = new List<TXN_Step__c>();
            Map<String, List<TXNFieldChangeWrapper>> changesByStepKey = new Map<String, List<TXNFieldChangeWrapper>>();
            for (String txId : eventByTransactionId.keySet()) {
                TXN_Log_Event__e eventValue = eventByTransactionId.get(txId);
                List<TXNStepWrapper> parsedSteps = parseSteps(eventValue.Steps_JSON__c);
                for (TXNStepWrapper step : parsedSteps) {
                    if (String.isBlank(step.stepKey)) {
                        step.stepKey = txId + '-' + step.sequenceNumber;
                    }
                    stepRows.add(new TXN_Step__c(
                        TXN_Log__c = logIdByTransactionId.get(txId),
                        Step_Key__c = step.stepKey,
                        Step_Name__c = step.stepName,
                        Step_Type__c = normalizeStepType(step.stepType),
                        Sequence_Number__c = step.sequenceNumber,
                        Status__c = normalizeStatus(step.status),
                        Error_Message__c = step.errorMessage,
                        Error_Class__c = step.errorClass,
                        Error_Line__c = step.errorLine,
                        Stack_Trace__c = step.stackTrace,
                        Duration_ms__c = step.durationMs,
                        Start_Time__c = fromMillis(step.startTime),
                        End_Time__c = fromMillis(step.endTime),
                        SOQL_Queries_Used__c = step.soqlQueriesUsed,
                        DML_Statements_Used__c = step.dmlStatementsUsed,
                        CPU_Time_Used_ms__c = step.cpuTimeUsed,
                        Heap_Size_Used_bytes__c = step.heapSizeUsed
                    ));
                    if (step.fieldChanges != null && !step.fieldChanges.isEmpty()) {
                        changesByStepKey.put(step.stepKey, step.fieldChanges);
                    }
                }
            }
            if (!stepRows.isEmpty()) {
                Database.upsert(stepRows, TXN_Step__c.Fields.Step_Key__c, false);
            }

            Map<String, Id> stepIdByKey = new Map<String, Id>();
            for (TXN_Step__c stepRow : [
                SELECT Id, Step_Key__c
                FROM TXN_Step__c
                WHERE Step_Key__c IN :changesByStepKey.keySet()
            ]) {
                stepIdByKey.put(stepRow.Step_Key__c, stepRow.Id);
            }
            List<TXN_Field_Change__c> fieldRows = new List<TXN_Field_Change__c>();
            for (String stepKey : changesByStepKey.keySet()) {
                for (TXNFieldChangeWrapper change : changesByStepKey.get(stepKey)) {
                    fieldRows.add(new TXN_Field_Change__c(
                        TXN_Step__c = stepIdByKey.get(stepKey),
                        Record_Id__c = change.recordId,
                        Field_API_Name__c = change.fieldAPIName,
                        Field_Label__c = change.fieldLabel,
                        Old_Value__c = change.oldValue,
                        New_Value__c = change.newValue,
                        Field_Type__c = change.fieldType
                    ));
                }
            }
            if (!fieldRows.isEmpty()) {
                Database.insert(fieldRows, false);
            }
        } catch (Exception ex) {
            System.debug('TXNLogEventHandler failed: ' + ex.getMessage());
        }
    }

    public static void handleStepEvents(List<TXN_Step_Log_Event__e> events) {
        try {
            if (events == null || events.isEmpty()) {
                return;
            }
            Set<String> transactionIds = new Set<String>();
            for (TXN_Step_Log_Event__e eventValue : events) {
                if (!String.isBlank(eventValue.Transaction_Id__c)) {
                    transactionIds.add(eventValue.Transaction_Id__c);
                }
            }
            Map<String, Id> logIdByTransactionId = ensureLogs(events, transactionIds);

            List<TXN_Step__c> persistedSteps = new List<TXN_Step__c>();
            for (TXN_Step_Log_Event__e eventValue : events) {
                if (String.isBlank(eventValue.Step_Key__c) || !logIdByTransactionId.containsKey(eventValue.Transaction_Id__c)) {
                    continue;
                }
                persistedSteps.add(new TXN_Step__c(
                    TXN_Log__c = logIdByTransactionId.get(eventValue.Transaction_Id__c),
                    Step_Key__c = eventValue.Step_Key__c,
                    Step_Name__c = eventValue.Step_Name__c,
                    Step_Type__c = normalizeStepType(eventValue.Step_Type__c),
                    Sequence_Number__c = eventValue.Sequence_Number__c,
                    Status__c = normalizeStatus(eventValue.Status__c),
                    Error_Message__c = eventValue.Error_Message__c,
                    Error_Class__c = eventValue.Error_Class__c,
                    Error_Line__c = eventValue.Error_Line__c,
                    Stack_Trace__c = eventValue.Stack_Trace__c,
                    Duration_ms__c = eventValue.Duration_ms__c,
                    Start_Time__c = fromMillis(eventValue.Start_Time__c),
                    End_Time__c = fromMillis(eventValue.End_Time__c),
                    SOQL_Queries_Used__c = eventValue.SOQL_Queries_Used__c,
                    DML_Statements_Used__c = eventValue.DML_Statements_Used__c,
                    CPU_Time_Used_ms__c = eventValue.CPU_Time_Used_ms__c,
                    Heap_Size_Used_bytes__c = eventValue.Heap_Size_Used_bytes__c
                ));
            }
            if (!persistedSteps.isEmpty()) {
                Database.upsert(persistedSteps, TXN_Step__c.Fields.Step_Key__c, false);
                syncLogSummaries(logIdByTransactionId.values());
            }
        } catch (Exception ex) {
            System.debug('TXNStepLogEventHandler failed: ' + ex.getMessage());
        }
    }

    public static void handleFieldChangeEvents(List<TXN_Field_Change_Event__e> events) {
        try {
            if (events == null || events.isEmpty()) {
                return;
            }
            Set<String> transactionIds = new Set<String>();
            Set<String> stepKeys = new Set<String>();
            for (TXN_Field_Change_Event__e eventValue : events) {
                if (!String.isBlank(eventValue.Transaction_Id__c)) {
                    transactionIds.add(eventValue.Transaction_Id__c);
                }
                if (!String.isBlank(eventValue.Step_Key__c)) {
                    stepKeys.add(eventValue.Step_Key__c);
                }
            }
            Map<String, Id> logIdByTransactionId = ensureLogs(transactionIds);
            Map<String, Id> stepIdByKey = ensureSteps(stepKeys);

            List<TXN_Field_Change__c> changes = new List<TXN_Field_Change__c>();
            for (TXN_Field_Change_Event__e eventValue : events) {
                if (String.isBlank(eventValue.Step_Key__c) || !stepIdByKey.containsKey(eventValue.Step_Key__c)) {
                    continue;
                }
                changes.add(new TXN_Field_Change__c(
                    TXN_Step__c = stepIdByKey.get(eventValue.Step_Key__c),
                    Record_Id__c = eventValue.Record_Id__c,
                    Field_API_Name__c = eventValue.Field_API_Name__c,
                    Field_Label__c = eventValue.Field_Label__c,
                    Old_Value__c = eventValue.Old_Value__c,
                    New_Value__c = eventValue.New_Value__c,
                    Field_Type__c = eventValue.Field_Type__c
                ));
            }
            if (!changes.isEmpty()) {
                Database.insert(changes, false);
            }
        } catch (Exception ex) {
            System.debug('TXNFieldChangeEventHandler failed: ' + ex.getMessage());
        }
    }

    private static List<TXNFieldChangeWrapper> captureChanges(Map<Id, SObject> oldMap, Map<Id, SObject> newMap, String objectAPIName) {
        List<TXNFieldChangeWrapper> changes = new List<TXNFieldChangeWrapper>();
        try {
            if (newMap == null || newMap.isEmpty() || String.isBlank(objectAPIName)) {
                return changes;
            }
            Schema.SObjectType objectType = Schema.getGlobalDescribe().get(objectAPIName);
            if (objectType == null) {
                return changes;
            }
            Map<String, Schema.SObjectField> fieldMap = objectType.getDescribe().fields.getMap();
            for (Id recordId : newMap.keySet()) {
                SObject newRecord = newMap.get(recordId);
                SObject oldRecord = oldMap == null ? null : oldMap.get(recordId);
                Map<String, Object> newValues = newRecord == null ? new Map<String, Object>() : newRecord.getPopulatedFieldsAsMap();
                Map<String, Object> oldValues = oldRecord == null ? new Map<String, Object>() : oldRecord.getPopulatedFieldsAsMap();
                Set<String> fieldNames = new Set<String>();
                fieldNames.addAll(newValues.keySet());
                fieldNames.addAll(oldValues.keySet());
                for (String fieldName : fieldNames) {
                    if (SKIPPED_FIELDS.contains(fieldName) || !fieldMap.containsKey(fieldName)) {
                        continue;
                    }
                    Object oldValue = oldValues.get(fieldName);
                    Object newValue = newValues.get(fieldName);
                    if (String.valueOf(oldValue) == String.valueOf(newValue)) {
                        continue;
                    }
                    Schema.DescribeFieldResult describeField = fieldMap.get(fieldName).getDescribe();
                    TXNFieldChangeWrapper change = new TXNFieldChangeWrapper();
                    change.recordId = String.valueOf(recordId);
                    change.fieldAPIName = fieldName;
                    change.fieldLabel = describeField.getLabel();
                    change.oldValue = String.valueOf(oldValue);
                    change.newValue = String.valueOf(newValue);
                    change.fieldType = String.valueOf(describeField.getType());
                    changes.add(change);
                }
            }
        } catch (Exception ex) {
            System.debug('FieldChangeTracker failed: ' + ex.getMessage());
        }
        return changes;
    }

    private static List<TXNStepWrapper> parseSteps(String stepsJson) {
        if (String.isBlank(stepsJson)) {
            return new List<TXNStepWrapper>();
        }
        try {
            return (List<TXNStepWrapper>) JSON.deserialize(stepsJson, List<TXNStepWrapper>.class);
        } catch (Exception ex) {
            System.debug('Unable to parse steps JSON: ' + ex.getMessage());
            return new List<TXNStepWrapper>();
        }
    }

    private static Map<String, Id> ensureLogs(Set<String> transactionIds) {
        return ensureLogs(new List<TXN_Step_Log_Event__e>(), transactionIds);
    }

    private static Map<String, Id> ensureLogs(List<TXN_Step_Log_Event__e> events, Set<String> transactionIds) {
        Map<String, Id> logIdByTransactionId = new Map<String, Id>();
        if (transactionIds == null || transactionIds.isEmpty()) {
            return logIdByTransactionId;
        }
        Map<String, TXN_Log__c> existingByTransactionId = new Map<String, TXN_Log__c>();
        for (TXN_Log__c logRow : [
            SELECT Id, Transaction_Id__c, Start_Time__c, Total_Steps__c
            FROM TXN_Log__c
            WHERE Transaction_Id__c IN :transactionIds
        ]) {
            existingByTransactionId.put(logRow.Transaction_Id__c, logRow);
            logIdByTransactionId.put(logRow.Transaction_Id__c, logRow.Id);
        }
        Map<String, List<TXN_Step_Log_Event__e>> eventsByTransactionId = new Map<String, List<TXN_Step_Log_Event__e>>();
        for (TXN_Step_Log_Event__e eventValue : events == null ? new List<TXN_Step_Log_Event__e>() : events) {
            if (String.isBlank(eventValue.Transaction_Id__c)) {
                continue;
            }
            if (!eventsByTransactionId.containsKey(eventValue.Transaction_Id__c)) {
                eventsByTransactionId.put(eventValue.Transaction_Id__c, new List<TXN_Step_Log_Event__e>());
            }
            eventsByTransactionId.get(eventValue.Transaction_Id__c).add(eventValue);
        }
        List<TXN_Log__c> logsToUpsert = new List<TXN_Log__c>();
        for (String txId : transactionIds) {
            TXN_Log__c existing = existingByTransactionId.get(txId);
            if (existing != null && existing.Start_Time__c != null && existing.Total_Steps__c != null && existing.Total_Steps__c > 0) {
                continue;
            }
            List<TXN_Step_Log_Event__e> relatedEvents = eventsByTransactionId.get(txId);
            TXN_Log__c fallback = buildFallbackLog(txId, relatedEvents);
            if (existing != null) {
                fallback.Id = existing.Id;
            }
            logsToUpsert.add(fallback);
        }
        if (!logsToUpsert.isEmpty()) {
            Database.upsert(logsToUpsert, TXN_Log__c.Fields.Transaction_Id__c, false);
            for (TXN_Log__c logRow : [
                SELECT Id, Transaction_Id__c
                FROM TXN_Log__c
                WHERE Transaction_Id__c IN :transactionIds
            ]) {
                logIdByTransactionId.put(logRow.Transaction_Id__c, logRow.Id);
            }
        }
        return logIdByTransactionId;
    }

    private static Map<String, Id> ensureSteps(Set<String> stepKeys) {
        Map<String, Id> stepIdByKey = new Map<String, Id>();
        if (stepKeys == null || stepKeys.isEmpty()) {
            return stepIdByKey;
        }
        for (TXN_Step__c step : [
            SELECT Id, Step_Key__c
            FROM TXN_Step__c
            WHERE Step_Key__c IN :stepKeys
        ]) {
            stepIdByKey.put(step.Step_Key__c, step.Id);
        }
        return stepIdByKey;
    }

    private static TXN_Log__c buildFallbackLog(String txId, List<TXN_Step_Log_Event__e> events) {
        TXN_Step_Log_Event__e firstEvent = events == null || events.isEmpty() ? null : events[0];
        Boolean failed = false;
        Decimal totalDuration = 0;
        String fallbackErrorMessage;
        String startTime;
        String endTime;
        for (TXN_Step_Log_Event__e eventValue : events == null ? new List<TXN_Step_Log_Event__e>() : events) {
            failed = failed || eventValue.Status__c == 'Failed';
            if (String.isBlank(fallbackErrorMessage) && !String.isBlank(eventValue.Error_Message__c)) {
                fallbackErrorMessage = eventValue.Error_Message__c;
            }
            totalDuration += eventValue.Duration_ms__c == null ? 0 : eventValue.Duration_ms__c;
            if (String.isBlank(startTime) || (!String.isBlank(eventValue.Start_Time__c) && eventValue.Start_Time__c < startTime)) {
                startTime = eventValue.Start_Time__c;
            }
            if (String.isBlank(endTime) || (!String.isBlank(eventValue.End_Time__c) && eventValue.End_Time__c > endTime)) {
                endTime = eventValue.End_Time__c;
            }
        }
        return new TXN_Log__c(
            Transaction_Id__c = txId,
            Object_API_Name__c = String.isBlank(firstEvent?.Object_API_Name__c) ? 'Unknown' : firstEvent.Object_API_Name__c,
            DML_Type__c = normalizeDml(firstEvent?.DML_Type__c),
            Triggered_By__c = firstEvent?.Triggered_By__c,
            Triggered_By_Id__c = firstEvent?.Triggered_By_Id__c,
            Status__c = failed ? 'Failed' : 'Success',
            Total_Steps__c = events == null ? 0 : events.size(),
            Total_Duration_ms__c = totalDuration,
            Error_Message__c = fallbackErrorMessage,
            Start_Time__c = fromMillis(startTime),
            End_Time__c = fromMillis(endTime),
            Record_Ids__c = firstEvent?.Record_Ids__c
        );
    }

    private static void syncLogSummaries(List<Id> logIds) {
        if (logIds == null || logIds.isEmpty()) {
            return;
        }
        Map<Id, List<TXN_Step__c>> stepsByLogId = new Map<Id, List<TXN_Step__c>>();
        for (TXN_Step__c step : [
            SELECT TXN_Log__c, Status__c, Error_Message__c, Duration_ms__c, Start_Time__c, End_Time__c
            FROM TXN_Step__c
            WHERE TXN_Log__c IN :logIds
        ]) {
            if (!stepsByLogId.containsKey(step.TXN_Log__c)) {
                stepsByLogId.put(step.TXN_Log__c, new List<TXN_Step__c>());
            }
            stepsByLogId.get(step.TXN_Log__c).add(step);
        }
        List<TXN_Log__c> logsToUpdate = new List<TXN_Log__c>();
        for (Id logId : stepsByLogId.keySet()) {
            Boolean failed = false;
            String summaryErrorMessage;
            Decimal duration = 0;
            Datetime startTime;
            Datetime endTime;
            for (TXN_Step__c step : stepsByLogId.get(logId)) {
                failed = failed || step.Status__c == 'Failed';
                if (String.isBlank(summaryErrorMessage) && !String.isBlank(step.Error_Message__c)) {
                    summaryErrorMessage = step.Error_Message__c;
                }
                duration += step.Duration_ms__c == null ? 0 : step.Duration_ms__c;
                if (startTime == null || (step.Start_Time__c != null && step.Start_Time__c < startTime)) {
                    startTime = step.Start_Time__c;
                }
                if (endTime == null || (step.End_Time__c != null && step.End_Time__c > endTime)) {
                    endTime = step.End_Time__c;
                }
            }
            logsToUpdate.add(new TXN_Log__c(
                Id = logId,
                Status__c = failed ? 'Failed' : 'Success',
                Total_Steps__c = stepsByLogId.get(logId).size(),
                Total_Duration_ms__c = duration,
                Error_Message__c = summaryErrorMessage,
                Start_Time__c = startTime,
                End_Time__c = endTime
            ));
        }
        if (!logsToUpdate.isEmpty()) {
            Database.update(logsToUpdate, false);
        }
    }

    private static void publishStepEvents() {
        List<TXN_Step_Log_Event__e> stepEvents = new List<TXN_Step_Log_Event__e>();
        for (TXNStepWrapper step : steps) {
            stepEvents.add(new TXN_Step_Log_Event__e(
                Transaction_Id__c = transactionId,
                Object_API_Name__c = objectName,
                DML_Type__c = dmlType,
                Record_Ids__c = left(recordIds, 255),
                Triggered_By__c = left(UserInfo.getName(), 100),
                Triggered_By_Id__c = UserInfo.getUserId(),
                Step_Key__c = left(step.stepKey, 80),
                Step_Name__c = left(step.stepName, 255),
                Step_Type__c = left(step.stepType, 40),
                Sequence_Number__c = step.sequenceNumber,
                Status__c = step.status,
                Error_Message__c = left(step.errorMessage, 255),
                Error_Class__c = left(step.errorClass, 255),
                Error_Line__c = step.errorLine,
                Stack_Trace__c = left(step.stackTrace, 255),
                Duration_ms__c = step.durationMs,
                Start_Time__c = String.valueOf(step.startTime),
                End_Time__c = String.valueOf(step.endTime),
                SOQL_Queries_Used__c = step.soqlQueriesUsed,
                DML_Statements_Used__c = step.dmlStatementsUsed,
                CPU_Time_Used_ms__c = step.cpuTimeUsed,
                Heap_Size_Used_bytes__c = step.heapSizeUsed
            ));
        }
        if (!stepEvents.isEmpty()) {
            EventBus.publish(stepEvents);
        }
    }

    private static void publishFieldChangeEvents() {
        List<TXN_Field_Change_Event__e> changeEvents = new List<TXN_Field_Change_Event__e>();
        for (TXNFieldChangeWrapper change : allFieldChanges) {
            changeEvents.add(new TXN_Field_Change_Event__e(
                Transaction_Id__c = transactionId,
                Step_Key__c = left(change.stepKey, 80),
                Record_Id__c = left(change.recordId, 18),
                Field_API_Name__c = left(change.fieldAPIName, 255),
                Field_Label__c = left(change.fieldLabel, 255),
                Old_Value__c = left(change.oldValue, 255),
                New_Value__c = left(change.newValue, 255),
                Field_Type__c = left(change.fieldType, 50)
            ));
        }
        if (!changeEvents.isEmpty()) {
            EventBus.publish(changeEvents);
        }
    }

    private static Boolean isRequiredForDml(String fieldName, Schema.DescribeFieldResult fieldDescribe, Boolean isInsert, Boolean isUpdate) {
        if (fieldName == 'Id' || fieldDescribe.isCalculated() || fieldDescribe.isAutoNumber() || fieldDescribe.isDefaultedOnCreate()) {
            return false;
        }
        if (fieldDescribe.isNillable()) {
            return false;
        }
        if (isInsert && !fieldDescribe.isCreateable()) {
            return false;
        }
        if (isUpdate && !fieldDescribe.isUpdateable()) {
            return false;
        }
        return isInsert || isUpdate;
    }

    private static String createTransactionId() {
        String randomPart = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).substring(0, 12);
        return 'TXN-' + String.valueOf(System.currentTimeMillis()) + '-' + randomPart;
    }

    private static String createFlowTransactionId(Integer index) {
        String randomPart = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).substring(0, 10);
        return 'FLOW-' + String.valueOf(System.currentTimeMillis()) + '-' + String.valueOf(index) + '-' + randomPart;
    }

    private static String buildRecordIds(Map<Id, SObject> oldMap, Map<Id, SObject> newMap) {
        Set<String> ids = new Set<String>();
        if (oldMap != null) {
            for (Id recordId : oldMap.keySet()) ids.add(String.valueOf(recordId));
        }
        if (newMap != null) {
            for (Id recordId : newMap.keySet()) ids.add(String.valueOf(recordId));
        }
        return String.join(new List<String>(ids), ',');
    }

    private static void mergeScope(Map<Id, SObject> oldMap, Map<Id, SObject> newMap) {
        if (oldRecords == null) {
            oldRecords = new Map<Id, SObject>();
        }
        if (newRecords == null) {
            newRecords = new Map<Id, SObject>();
        }
        if (oldMap != null) {
            oldRecords.putAll(oldMap);
        }
        if (newMap != null) {
            newRecords.putAll(newMap);
        }
    }

    private static Datetime fromMillis(Object value) {
        if (value == null || String.isBlank(String.valueOf(value))) {
            return null;
        }
        try {
            Long millis = Long.valueOf(String.valueOf(value));
            return Datetime.newInstance(1970, 1, 1).addSeconds(Integer.valueOf(millis / 1000));
        } catch (Exception ex) {
            return null;
        }
    }

    private static String normalizeStatus(String value) {
        return value == 'Failed' ? 'Failed' : 'Success';
    }

    private static String normalizeStatus(String statusValue, String flowErrorMessage) {
        if (statusValue == 'Failed' || !String.isBlank(flowErrorMessage)) {
            return 'Failed';
        }
        return 'Success';
    }

    private static String normalizeDml(String value) {
        Set<String> allowed = new Set<String>{ 'Insert', 'Update', 'Delete', 'Undelete' };
        return allowed.contains(value) ? value : 'Update';
    }

    private static String normalizeStepType(String value) {
        Set<String> allowed = new Set<String>{ 'Before Insert', 'Before Update', 'Before Delete', 'After Insert', 'After Update', 'After Delete', 'After Undelete', 'Flow' };
        return allowed.contains(value) ? value : 'After Update';
    }

    private static String left(String value, Integer maxLength) {
        if (value == null || value.length() <= maxLength) {
            return value;
        }
        return value.substring(0, maxLength);
    }

    private static String dataErrorMessage(String operation, Exception ex) {
        String raw = ex == null || String.isBlank(ex.getMessage()) ? '' : ex.getMessage();
        String lower = raw.toLowerCase();
        if (lower.contains('insufficient access') || lower.contains('no access')) {
            return operation + ' failed because this user does not have access to the visualizer data objects. Assign the required permission set and try again.';
        }
        if (lower.contains('invalid sobject type') || lower.contains('invalid field')) {
            return operation + ' failed because one or more visualizer metadata objects/fields are missing. Deploy the complete package, then try again.';
        }
        if (lower.contains('malformed') || lower.contains('invalid')) {
            return operation + ' received invalid data. Refresh the queue and try again.';
        }
        return operation + ' failed. Verify object permissions and that the visualizer metadata is deployed, then try again.';
    }

    @TestVisible
    private static void reset() {
        transactionId = null;
        objectName = null;
        dmlType = null;
        status = 'Success';
        errorMessage = null;
        transactionStart = null;
        transactionEnd = null;
        sequenceNumber = 0;
        currentStep = null;
        steps.clear();
        allFieldChanges.clear();
        oldRecords = null;
        newRecords = null;
        recordIds = null;
        published = false;
    }
}

/**
 * @description Unit tests for DebugLogController methods and SOQL-first filter strategy.
 * 
 * @author Senior Salesforce Architect
 * @date 2026-07-31
 */
@IsTest
global class DebugLogControllerTest {

    private class TestMessageException extends Exception {}

    global class TestHttpMock implements HttpCalloutMock {
        private Integer statusCode;
        private String body;

        TestHttpMock(Integer statusCode, String body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        global HttpResponse respond(HttpRequest request) {
            HttpResponse response = new HttpResponse();
            response.setStatusCode(this.statusCode);
            response.setBody(this.body);
            return response;
        }
    }

    private static ApexLog buildTestLog() {
        return (ApexLog) JSON.deserialize(
            '{"attributes":{"type":"ApexLog"},"Id":"07L000000000001AAA","Operation":"/aura","Status":"Success","StartTime":"2026-08-01T12:00:00.000Z","LogUserId":"005000000000001AAA","LogLength":256,"Request":"Application","Application":"Browser"}',
            ApexLog.class
        );
    }

    private static String buildControllerLogBody() {
        return String.join(new List<String>{
            '17:05:00.100 (10000000)|EXECUTION_STARTED',
            '17:05:00.105 (10500000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event BeforeInsert',
            '17:05:00.110 (11000000)|DML_BEGIN|[12]|Op:Insert|Type:Account|Rows:2',
            '17:05:00.115 (11500000)|SOQL_EXECUTE_BEGIN|[15]|Aggregations:0|SELECT Id FROM Account',
            '17:05:00.120 (12000000)|SOQL_EXECUTE_END|[15]|Rows:2',
            '17:05:00.125 (12500000)|DML_END|[12]',
            '17:05:00.130 (13000000)|CODE_UNIT_FINISHED|AccountTrigger on Account trigger event BeforeInsert',
            '17:05:00.135 (13500000)|EXECUTION_FINISHED'
        }, '\n');
    }

    @IsTest
    static void testGetRecentLogs() {
        Test.startTest();
        List<DebugLogController.LogWrapper> logs = DebugLogController.getRecentDmlLogs();
        Test.stopTest();
        System.assertNotEquals(null, logs, 'getRecentDmlLogs should return a non-null list');
    }

    @IsTest
    static void testGetAnalyzedRecentDmlLogs() {
        Test.startTest();
        List<DebugLogController.DebugTransactionWrapper> results = DebugLogController.getAnalyzedRecentDmlLogs('All', 'All', 'All', 10);
        List<DebugLogController.DebugTransactionWrapper> filteredResults = DebugLogController.getAnalyzedRecentDmlLogsWithFilters(
            'Account', 'Success', 'Insert', Date.today().addDays(-1), Date.today().addDays(1), 'Test', 10
        );
        Test.stopTest();
        System.assertNotEquals(null, results, 'Results list should not be null');
        System.assertNotEquals(null, filteredResults, 'Filtered results list should not be null');
    }

    @IsTest
    static void testParseLogBlankId() {
        Boolean exceptionThrown = false;
        try {
            Test.startTest();
            DebugLogController.parseLog('');
            Test.stopTest();
        } catch (AuraHandledException ex) {
            exceptionThrown = true;
        }
        System.assertEquals(true, exceptionThrown, 'Should throw AuraHandledException when logId is blank');
    }

    @IsTest
    static void testFetchLogBodyBlankId() {
        Boolean exceptionThrown = false;
        try {
            Test.startTest();
            DebugLogController.fetchLogBody('');
            Test.stopTest();
        } catch (AuraHandledException ex) {
            exceptionThrown = true;
        }
        System.assertEquals(true, exceptionThrown, 'Should throw AuraHandledException when logId is blank');
    }

    @IsTest
    static void testQueueWrapperAndInternalObjectRules() {
        ApexLog log = buildTestLog();

        DebugLogController.LogWrapper wrapper = DebugLogController.queueWrapper(log);

        System.assertEquals(log.Id, wrapper.Id);
        System.assertEquals('/aura', wrapper.Operation);
        System.assertEquals('Pending', wrapper.IndexStatus);
        System.assertEquals(false, wrapper.IsDmlSummary);
        System.assertEquals(null, wrapper.DmlSummaryJson);
        System.assertEquals(false, DebugLogController.isToolingApiNoise(log));

        System.assertEquals(true, DebugLogController.isInternalDmlObject('TXN_Log_Event__e'));
        System.assertEquals(true, DebugLogController.isInternalDmlObject('Custom_Event__e'));
        System.assertEquals(true, DebugLogController.isInternalDmlObject('ApexLog'));
        System.assertEquals(false, DebugLogController.isInternalDmlObject('Account'));
    }

    @IsTest
    static void testBusinessDmlSummaryAndParsingHelpers() {
        String body = String.join(new List<String>{
            'not a debug line',
            '17:05:00.100 (10000000)|DML_BEGIN|[1]|Op:Insert|Type:Account|Rows:3',
            '17:05:00.110 (11000000)|DML_END|[1]',
            '17:05:00.120 (12000000)|DML_BEGIN|[2]|Op:Update|Type:TXN_Log_Event__e|Rows:2',
            '17:05:00.130 (13000000)|DML_END|[2]',
            '17:05:00.140 (14000000)|DML_BEGIN|[3]|Op:Update|Type:Contact',
            '17:05:00.150 (15000000)|DML_END|[3]',
            '17:05:00.160 (16000000)|DML_BEGIN|[4]|Op:Delete|Type:Lead|Rows:not-a-number'
        }, '\n');

        List<DebugLogController.DmlSummary> summaries = DebugLogController.extractBusinessDmlSummaries(body);
        System.assertEquals(3, summaries.size(), 'Only business DML summaries should remain');
        System.assertEquals('Account', summaries[0].objectName);
        System.assertEquals(3, summaries[0].rows);
        System.assertEquals('Contact', summaries[1].objectName);
        System.assertEquals(1, summaries[1].rows);
        System.assertEquals('Lead', summaries[2].objectName);
        System.assertEquals(1, summaries[2].rows);
        System.assertEquals(0, DebugLogController.extractBusinessDmlSummaries('').size());

        System.assertEquals('17:05:00', DebugLogController.parseTimestampString('17:05:00.100 (10000000)'));
        System.assertEquals('-', DebugLogController.parseTimestampString(null));
        System.assertEquals(10000000L, DebugLogController.parseTimestampNanos('17:05:00.100 (10000000)'));
        System.assertEquals(null, DebugLogController.parseTimestampNanos('invalid'));
        System.assertEquals(12, DebugLogController.parseInteger('12', 1));
        System.assertEquals(1, DebugLogController.parseInteger('bad', 1));
        System.assertEquals(12L, DebugLogController.parseLong('12'));
        System.assertEquals(null, DebugLogController.parseLong('bad'));
    }

    @IsTest
    static void testAnalyzeLogAndFailureMessages() {
        DebugLogController.DebugTransactionWrapper parsedTransaction = DebugLogController.analyzeLog(
            buildTestLog(),
            buildControllerLogBody()
        );

        System.assertNotEquals(null, parsedTransaction);
        System.assertEquals('Account', parsedTransaction.objectApiName);
        System.assertEquals('Insert', parsedTransaction.operation);
        System.assertEquals(1, parsedTransaction.dmlEvents.size());
        System.assertEquals(1, parsedTransaction.soqlEvents.size());
        System.assert(parsedTransaction.timeline.size() > 0);

        System.assert(DebugLogController.buildFetchFailureMessage(new TestMessageException('Named Credential denied')).startsWith('TOOLING_AUTH:'));
        System.assert(DebugLogController.buildFetchFailureMessage(new TestMessageException('request timeout')).startsWith('TOOLING_TIMEOUT:'));
        System.assert(DebugLogController.buildFetchFailureMessage(new TestMessageException('network unavailable')).startsWith('TOOLING_UNAVAILABLE:'));
        System.assertEquals('No additional error details were provided.', DebugLogController.safeExceptionMessage(null));
        System.assertEquals('example', DebugLogController.safeExceptionMessage(new TestMessageException('example')));
    }

    private static void assertFetchFailure(Integer statusCode) {
        Test.setMock(HttpCalloutMock.class, new TestHttpMock(statusCode, 'failure'));
        Boolean thrown = false;
        try {
            DebugLogController.fetchLogBodyInternal('07L000000000001AAA');
        } catch (AuraHandledException ex) {
            thrown = true;
        }
        System.assertEquals(true, thrown, 'Expected a handled failure for HTTP ' + statusCode);
    }

    @IsTest
    static void testFetchLogBodyInternalResponses() {
        Test.startTest();
        Test.setMock(HttpCalloutMock.class, new TestHttpMock(200, 'log body'));
        System.assertEquals('log body', DebugLogController.fetchLogBodyInternal('07L000000000001AAA'));
        assertFetchFailure(401);
        assertFetchFailure(403);
        assertFetchFailure(404);
        assertFetchFailure(400);
        assertFetchFailure(500);
        Test.stopTest();
    }

    @IsTest
    static void testMissingLogMessages() {
        Boolean parseThrown = false;
        try {
            DebugLogController.parseLog('07L000000000002AAA');
        } catch (AuraHandledException ex) {
            parseThrown = true;
        }
        System.assertEquals(true, parseThrown);

        Boolean fetchThrown = false;
        try {
            DebugLogController.fetchLogBody('07L000000000002AAA');
        } catch (AuraHandledException ex) {
            fetchThrown = true;
        }
        System.assertEquals(true, fetchThrown);
    }

    @IsTest(SeeAllData=true)
    static void testPublicLogPathsWhenLogExists() {
        List<ApexLog> logs = [
            SELECT Id, Operation, Status, StartTime, LogUserId, LogLength, Request, Application
            FROM ApexLog
            WHERE LogUserId = :UserInfo.getUserId()
              AND LogLength <= 5000000
            ORDER BY StartTime DESC
            LIMIT 1
        ];
        if (logs.isEmpty()) {
            return;
        }

        Test.setMock(HttpCalloutMock.class, new TestHttpMock(200, buildControllerLogBody()));
        Test.startTest();
        List<DebugLogController.DebugTransactionWrapper> parsed = DebugLogController.parseLog(logs[0].Id);
        String body = DebugLogController.fetchLogBody(logs[0].Id);
        Test.stopTest();

        System.assert(parsed.size() > 0);
        System.assert(body.contains('DML_BEGIN'));
    }
}

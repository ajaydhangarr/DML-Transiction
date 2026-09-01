/**
 * @description Unit tests for DebugLogController methods and SOQL-first filter strategy.
 * 
 * @author Senior Salesforce Architect
 * @date 2026-07-31
 */
@IsTest
public class DebugLogControllerTest {

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
}

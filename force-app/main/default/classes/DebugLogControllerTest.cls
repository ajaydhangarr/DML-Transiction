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
    System.assertNotEquals(
      null,
      logs,
      'getRecentDmlLogs should return a non-null list'
    );
  }

  @IsTest
  static void testGetAnalyzedRecentDmlLogs() {
    Test.startTest();
    List<DebugLogController.DebugTransactionWrapper> results = DebugLogController.getAnalyzedRecentDmlLogs(
      'All',
      'All',
      'All',
      10
    );
    List<DebugLogController.DebugTransactionWrapper> filteredResults = DebugLogController.getAnalyzedRecentDmlLogsWithFilters(
      'Account',
      'Success',
      'Insert',
      Date.today().addDays(-1),
      Date.today().addDays(1),
      'Test',
      10
    );
    Test.stopTest();
    System.assertNotEquals(null, results, 'Results list should not be null');
    System.assertNotEquals(
      null,
      filteredResults,
      'Filtered results list should not be null'
    );
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
    System.assertEquals(
      true,
      exceptionThrown,
      'Should throw AuraHandledException when logId is blank'
    );
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
    System.assertEquals(
      true,
      exceptionThrown,
      'Should throw AuraHandledException when logId is blank'
    );
  }

  @IsTest
  static void testFetchLogBodyCalloutSuccess() {
    Test.setMock(
      HttpCalloutMock.class,
      new DebugLogHttpMock(200, '10:00:00.000|EXECUTION_STARTED')
    );

    Test.startTest();
    String body = DebugLogController.fetchLogBodyInternal('07L000000000001');
    Test.stopTest();

    System.assertEquals(
      '10:00:00.000|EXECUTION_STARTED',
      body,
      'Successful callouts should return the log body'
    );
  }

  @IsTest
  static void testFetchLogBodyCalloutErrorIsSanitized() {
    Test.setMock(
      HttpCalloutMock.class,
      new DebugLogHttpMock(500, '{"message":"secret endpoint details"}')
    );

    Boolean exceptionThrown = false;
    try {
      Test.startTest();
      DebugLogController.fetchLogBodyInternal('07L000000000001');
      Test.stopTest();
    } catch (AuraHandledException ex) {
      exceptionThrown = true;
      System.assertEquals(
        'Unable to fetch this debug log from Salesforce. Please try again.',
        ex.getMessage(),
        'Callout details must not be exposed to users'
      );
    }
    System.assertEquals(
      true,
      exceptionThrown,
      'Non-success callouts should throw a handled error'
    );
  }

  @IsTest
  static void testControllerParsingHelpers() {
    String body =
      '10:00:00.123 (100)|DML_BEGIN|Op:INSERT|Type:Account|Rows:2\n' +
      '10:00:00.456 (250)|DML_END\n' +
      '10:00:01.000|DML_BEGIN|Op:UPDATE|Type:Contact|Rows:not-a-number\n' +
      '10:00:01.500|DML_END\n' +
      '10:00:02.000|DML_BEGIN|Op:DELETE|Type:ApexLog|Rows:1\n' +
      '10:00:03.000|DML_END\n' +
      'malformed line\n' +
      '10:00:04.000|DML_BEGIN|Op:INSERT|Type:Lead|Rows:1';

    List<DebugLogController.DmlSummary> summaries = DebugLogController.extractBusinessDmlSummaries(
      body
    );

    System.assertEquals(3, summaries.size(), 'Only business DML should remain');
    System.assertEquals('Account', summaries[0].objectName);
    System.assertEquals(
      1,
      summaries[1].rows,
      'Invalid row counts should use the fallback value'
    );
    System.assertEquals(
      'Lead',
      summaries[2].objectName,
      'Open business DML should be retained'
    );

    System.assertEquals(
      '-',
      DebugLogController.parseTimestampString(''),
      'Blank timestamps should use the placeholder'
    );
    System.assertEquals(
      '10:00:00',
      DebugLogController.parseTimestampString('10:00:00.123 UTC'),
      'Timestamp fractions and timezone text should be removed'
    );
    System.assertEquals(
      null,
      DebugLogController.parseTimestampNanos('10:00:00'),
      'Timestamps without nanos should return null'
    );
    System.assertEquals(
      100,
      DebugLogController.parseTimestampNanos('10:00:00 (100)')
    );
    System.assertEquals(7, DebugLogController.parseInteger('bad', 7));
    System.assertEquals(12, DebugLogController.parseInteger('12', 7));
    System.assertEquals(null, DebugLogController.parseLong('bad'));
    System.assertEquals(12, DebugLogController.parseLong('12'));
    System.assertEquals(
      true,
      DebugLogController.isInternalDmlObject('ApexLog')
    );
    System.assertEquals(
      true,
      DebugLogController.isInternalDmlObject('Audit_Event__e')
    );
    System.assertEquals(
      false,
      DebugLogController.isInternalDmlObject('Account')
    );
  }

  @IsTest
  static void testControllerLimitAndQueueHelpers() {
    DebugLogController.QueueResponse response = DebugLogController.getQueueLogs();
    System.assertNotEquals(null, response);

    System.assertNotEquals(
      null,
      DebugLogController.getAnalyzedRecentDmlLogsWithFilters(
        null,
        'All',
        'All',
        null,
        null,
        'All',
        null
      )
    );
    System.assertNotEquals(
      null,
      DebugLogController.getAnalyzedRecentDmlLogsWithFilters(
        null,
        'Success',
        'Insert',
        Date.today().addDays(-1),
        Date.today().addDays(1),
        'Test',
        51
      )
    );

    ApexLog log = new ApexLog();
    DebugLogController.LogWrapper wrapper = DebugLogController.queueWrapper(
      log
    );
    System.assertEquals('Pending', wrapper.IndexStatus);
    System.assertEquals(false, wrapper.IsDmlSummary);
    System.assertEquals(false, DebugLogController.isToolingApiNoise(log));
  }

  private class DebugLogHttpMock implements HttpCalloutMock {
    private Integer statusCode;
    private String responseBody;

    DebugLogHttpMock(Integer statusCode, String responseBody) {
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }

    public HttpResponse respond(HttpRequest request) {
      HttpResponse response = new HttpResponse();
      response.setStatusCode(statusCode);
      response.setBody(responseBody);
      return response;
    }
  }
}

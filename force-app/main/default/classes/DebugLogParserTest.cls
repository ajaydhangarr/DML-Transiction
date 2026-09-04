/**
 * @description Unit tests for DebugLogParser state machine and ILogParser implementation.
 *
 * @author Senior Salesforce Architect
 * @date 2026-07-31
 */
@IsTest
public class DebugLogParserTest {
  private static String buildMultiDmlLogBody() {
    List<String> lines = new List<String>();
    lines.add('48.0 APEX_CODE,FINEST;DML,FINER;LOGICAL,ALL');
    lines.add('17:05:00.100 (10000000)|EXECUTION_STARTED');
    lines.add(
      '17:05:00.102 (10200000)|CODE_UNIT_STARTED|[EXTERNAL]|01q5h0000001ABC|AccountTrigger on Account trigger event BeforeInsert'
    );
    lines.add(
      '17:05:00.105 (10500000)|DML_BEGIN|[12]|Op:Insert|Type:Account|Rows:1'
    );
    lines.add(
      '17:05:00.110 (11000000)|SOQL_EXECUTE_BEGIN|[15]|Aggregations:0|SELECT Id, Name FROM Account WHERE Id = \'001000000000001\''
    );
    lines.add('17:05:00.115 (11500000)|SOQL_EXECUTE_END|[15]|Rows:1');
    lines.add('17:05:00.120 (12000000)|DML_END|[12]');
    lines.add(
      '17:05:00.125 (12500000)|CODE_UNIT_FINISHED|AccountTrigger on Account trigger event BeforeInsert'
    );
    lines.add('17:05:00.130 (13000000)|FLOW_START_INTERVIEW|OrderProcess|Flow');
    lines.add(
      '17:05:00.135 (13500000)|FLOW_ELEMENT_BEGIN|Update_Contact|FlowRecordUpdate|UpdateContactElem'
    );
    lines.add(
      '17:05:00.140 (14000000)|DML_BEGIN|[20]|Op:Update|Type:Contact|Rows:3'
    );
    lines.add('17:05:00.145 (14500000)|DML_END|[20]');
    lines.add(
      '17:05:00.150 (15000000)|FLOW_ELEMENT_END|Update_Contact|FlowRecordUpdate|UpdateContactElem'
    );
    lines.add(
      '17:05:00.155 (15500000)|DML_BEGIN|[30]|Op:Delete|Type:Task|Rows:5'
    );
    lines.add(
      '17:05:00.160 (16000000)|EXCEPTION_THROWN|[35]|System.DmlException: Delete failed.'
    );
    lines.add(
      '17:05:00.165 (16500000)|FATAL_ERROR|System.DmlException: Delete failed.'
    );
    lines.add('17:05:00.170 (17000000)|DML_END|[30]');
    lines.add(
      '17:05:00.175 (17500000)|CUMULATIVE_LIMIT_USAGE|Number of SOQL queries: 1 out of 100|Number of DML statements: 3 out of 150|Maximum CPU time: 50 out of 10000|Maximum heap size: 12000 out of 6000000'
    );
    lines.add('17:05:00.180 (18000000)|EXECUTION_FINISHED');
    return String.join(lines, '\n');
  }

  @IsTest
  static void testParseMultiDmlLog() {
    String logBody = buildMultiDmlLogBody();
    ILogParser parser = new DebugLogParser();

    Test.startTest();
    List<DebugLogController.DebugTransactionWrapper> transactions = parser.parseAll(
      null,
      logBody
    );
    DebugLogController.DebugTransactionWrapper primary = parser.parse(
      null,
      logBody
    );
    Test.stopTest();

    System.assertNotEquals(
      null,
      transactions,
      'Transactions list should not be null'
    );
    System.assertEquals(
      3,
      transactions.size(),
      'Should extract 3 DML transactions from log body'
    );

    // Verify DML 1: Insert Account (log-level failure due to exception in log)
    DebugLogController.DebugTransactionWrapper txn1 = transactions[0];
    System.assertEquals('Account', txn1.objectApiName);
    System.assertEquals('Insert', txn1.operation);
    System.assertEquals(
      'Failed',
      txn1.status,
      'Log containing unhandled exception should mark transaction status as Failed'
    );
    System.assertNotEquals(null, txn1.timeline);
    System.assert(
      txn1.timeline.size() > 0,
      'Timeline entries should be populated'
    );

    // Verify DML 2: Update Contact
    DebugLogController.DebugTransactionWrapper txn2 = transactions[1];
    System.assertEquals('Contact', txn2.objectApiName);
    System.assertEquals('Update', txn2.operation);

    // Verify DML 3: Delete Task with Exception
    DebugLogController.DebugTransactionWrapper txn3 = transactions[2];
    System.assertEquals('Task', txn3.objectApiName);
    System.assertEquals('Delete', txn3.operation);
    System.assertEquals('Failed', txn3.status);
    System.assert(
      txn3.errorMessage.contains('Delete failed'),
      'Error message should be captured'
    );

    System.assertNotEquals(
      null,
      primary,
      'Primary single transaction should be returned'
    );
    System.assertEquals('Account', primary.objectApiName);
  }

  @IsTest
  static void testFilterMatching() {
    DebugLogController.DebugTransactionWrapper txn = new DebugLogController.DebugTransactionWrapper();
    txn.objectApiName = 'Account';
    txn.operation = 'Insert';
    txn.dmlType = 'Insert';
    txn.status = 'Success';
    txn.userName = 'Test User';
    txn.startTime = Datetime.now();

    System.assertEquals(
      true,
      DebugLogParser.matchesFilter(
        txn,
        'Account',
        'Success',
        'Insert',
        null,
        null,
        'Test'
      )
    );
    System.assertEquals(
      false,
      DebugLogParser.matchesFilter(
        txn,
        'Contact',
        'Success',
        'Insert',
        null,
        null,
        'Test'
      )
    );
    System.assertEquals(
      false,
      DebugLogParser.matchesFilter(
        txn,
        'Account',
        'Failed',
        'Insert',
        null,
        null,
        'Test'
      )
    );
    System.assertEquals(
      false,
      DebugLogParser.matchesFilter(
        txn,
        'Account',
        'Success',
        'Update',
        null,
        null,
        'Test'
      )
    );
    System.assertEquals(
      false,
      DebugLogParser.matchesFilter(
        txn,
        'Account',
        'Success',
        'Insert',
        null,
        null,
        'UnknownUser'
      )
    );
  }

  @IsTest
  static void testEmptyLogBody() {
    ILogParser parser = new DebugLogParser();
    List<DebugLogController.DebugTransactionWrapper> results = parser.parseAll(
      null,
      ''
    );
    System.assertEquals(
      0,
      results.size(),
      'Empty body should return empty list'
    );
  }
}

const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(__dirname, '..', 'test-fixtures', 'synthetic-nested-apex-flow-40mb.log');
const targetBytes = 40_000_000;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

let fileBytes = 0;
let lineCount = 0;
let eventCount = 0;
let sequence = 1;
const fileHandle = fs.openSync(outputPath, 'w');

function timestamp() {
  const millis = Math.floor(sequence / 10);
  const hours = String(Math.floor(millis / 3_600_000)).padStart(2, '0');
  const minutes = String(Math.floor((millis % 3_600_000) / 60_000)).padStart(2, '0');
  const seconds = String(Math.floor((millis % 60_000) / 1_000)).padStart(2, '0');
  const milliseconds = String(millis % 1_000).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds} (${sequence * 100_000})`;
}

function emit(eventType, detail) {
  const line = `${timestamp()}|${eventType}|${detail}\n`;
  const buffer = Buffer.from(line, 'utf8');
  if (fileBytes + buffer.length > targetBytes) return false;
  fs.writeSync(fileHandle, buffer);
  fileBytes += buffer.length;
  lineCount += 1;
  eventCount += 1;
  sequence += 1;
  return true;
}

function emitVariableAssignments(transactionNumber, count, objectName, prefix) {
  for (let index = 0; index < count; index += 1) {
    const recordNumber = transactionNumber * 10_000 + index;
    if (!emit(
      'VARIABLE_ASSIGNMENT',
      `[${index + 1}]|${prefix}${index % 4}|${objectName}:{Id=00QTEST${String(recordNumber).padStart(9, '0')},FirstName=BulkTest,LastName=Lead ${recordNumber},Company=Nested Test Corp ${transactionNumber},Status=Open - Not Contacted,LeadSource=Web}`
    )) return false;
  }
  return true;
}

function emitFlow(flowName, transactionNumber, depth) {
  const flowId = `301TEST${String(transactionNumber).padStart(9, '0')}`;
  if (!emit('FLOW_START_INTERVIEW_BEGIN', `[EXTERNAL]|Flow: ${flowName}|Interview Label: ${flowName} ${transactionNumber}`)) return false;
  if (!emit('FLOW_ELEMENT_BEGIN', `[EXTERNAL]|${flowId}|${flowName}|Get Records: Load related records`)) return false;
  if (!emit('SOQL_EXECUTE_BEGIN', `[${depth + 10}]|Aggregations:0|SELECT Id, Name FROM Account WHERE Name LIKE 'Nested%' LIMIT 5`)) return false;
  if (!emit('SOQL_EXECUTE_END', `[${depth + 10}]|Rows:5`)) return false;
  if (!emit('FLOW_ELEMENT_END', `[EXTERNAL]|${flowId}|${flowName}|Get Records: Load related records`)) return false;
  if (!emit('FLOW_ELEMENT_BEGIN', `[EXTERNAL]|${flowId}|${flowName}|Decision: Check validation path`)) return false;
  if (!emit('FLOW_ELEMENT_ERROR', `[EXTERNAL]|${flowId}|${flowName}|Warning path observed for test transaction`)) return false;
  if (!emit('FLOW_ELEMENT_END', `[EXTERNAL]|${flowId}|${flowName}|Decision: Check validation path`)) return false;
  if (!emit('FLOW_START_INTERVIEW_END', `[EXTERNAL]|${flowId}|${flowName}`)) return false;
  return true;
}

function emitNestedTrigger(triggerName, objectName, transactionNumber, depth, assignmentCount) {
  const triggerId = `01qTEST${String(transactionNumber + depth).padStart(9, '0')}`;
  if (!emit('CODE_UNIT_STARTED', `[TRIGGER]|${triggerId}|${triggerName} on ${objectName} trigger event AfterInsert`)) return false;
  if (!emit('METHOD_ENTRY', `[${depth + 20}]|${triggerId}|${triggerName}Handler.process(List<${objectName}>)`)) return false;
  if (!emit('VALIDATION_RULE', `[${depth + 21}]|${objectName}: ${objectName}RequiredFields|Formula evaluated`)) return false;
  if (!emit('VALIDATION_PASS', `[${depth + 21}]|${objectName}: ${objectName}RequiredFields`)) return false;
  if (!emitFlow(`${objectName} Automation Flow`, transactionNumber, depth)) return false;
  if (!emitVariableAssignments(transactionNumber, assignmentCount, objectName, `${objectName.toLowerCase()}Var`)) return false;
  if (!emit('METHOD_EXIT', `[${depth + 20}]|${triggerId}|${triggerName}Handler.process(List<${objectName}>)`)) return false;
  if (!emit('CODE_UNIT_FINISHED', `[TRIGGER]|${triggerId}|${triggerName} on ${objectName} trigger event AfterInsert`)) return false;
  return true;
}

function emitTransaction(transactionNumber) {
  if (!emit('CODE_UNIT_STARTED', `[EXTERNAL]|execute_anonymous_apex|SyntheticTransaction ${transactionNumber}`)) return false;
  if (!emit('METHOD_ENTRY', `[1]|01pdTEST000000001|LeadTestHelper.performTestOperations(List<Lead>)`)) return false;
  if (!emit('DML_BEGIN', `[10]|Op:Insert|Type:Lead|Rows:200`)) return false;
  if (!emit('CODE_UNIT_STARTED', `[TRIGGER]|01qTEST${String(transactionNumber).padStart(9, '0')}|LeadTrigger on Lead trigger event BeforeInsert`)) return false;
  if (!emit('METHOD_ENTRY', `[11]|01qTEST${String(transactionNumber).padStart(9, '0')}|LeadTriggerHandler.beforeInsert(List<Lead>)`)) return false;
  if (!emit('VALIDATION_RULE', `[12]|Lead: Validate_Company|Formula evaluated`)) return false;
  if (!emit(transactionNumber % 7 === 0 ? 'VALIDATION_FAIL' : 'VALIDATION_PASS', `[12]|Lead: Validate_Company|${transactionNumber % 7 === 0 ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Company is required' : 'Validation passed'}`)) return false;
  if (!emitFlow('Lead Record Triggered Flow', transactionNumber, 1)) return false;
  if (!emit('DML_BEGIN', `[20]|Op:Update|Type:Contact|Rows:25`)) return false;
  if (!emitNestedTrigger('ContactTrigger', 'Contact', transactionNumber, 2, 12)) return false;
  if (!emit('DML_BEGIN', `[30]|Op:Insert|Type:Task|Rows:25`)) return false;
  if (!emitNestedTrigger('TaskTrigger', 'Task', transactionNumber, 3, 10)) return false;
  if (!emit('DML_BEGIN', `[40]|Op:Upsert|Type:Case|Rows:5`)) return false;
  if (!emitNestedTrigger('CaseTrigger', 'Case', transactionNumber, 4, 8)) return false;
  if (!emit('DML_END', `[40]|Rows:5`)) return false;
  if (!emit('DML_END', `[30]|Rows:25`)) return false;
  if (!emit('DML_END', `[20]|Rows:25`)) return false;
  if (!emitVariableAssignments(transactionNumber, 850, 'Lead', 'leadRecord')) return false;
  if (!emit('METHOD_EXIT', `[11]|01qTEST${String(transactionNumber).padStart(9, '0')}|LeadTriggerHandler.beforeInsert(List<Lead>)`)) return false;
  if (!emit('CODE_UNIT_FINISHED', `[TRIGGER]|01qTEST${String(transactionNumber).padStart(9, '0')}|LeadTrigger on Lead trigger event BeforeInsert`)) return false;
  if (!emit('DML_END', `[10]|Rows:200`)) return false;
  if (!emit('METHOD_EXIT', `[1]|01pdTEST000000001|LeadTestHelper.performTestOperations(List<Lead>)`)) return false;
  if (!emit('CODE_UNIT_FINISHED', `[EXTERNAL]|execute_anonymous_apex|SyntheticTransaction ${transactionNumber}`)) return false;
  return true;
}

emit('USER_DEBUG', '[1]|Synthetic 40 MB nested Apex/Flow test log started');
let transactionNumber = 1;
while (fileBytes < targetBytes) {
  if (!emitTransaction(transactionNumber)) break;
  transactionNumber += 1;
}

fs.closeSync(fileHandle);

console.log(JSON.stringify({
  outputPath,
  bytes: fileBytes,
  megabytes: Number((fileBytes / 1_000_000).toFixed(2)),
  lines: lineCount,
  events: eventCount,
  syntheticTransactions: transactionNumber - 1
}));

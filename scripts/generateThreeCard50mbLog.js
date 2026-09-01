const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(__dirname, '..', 'test-fixtures', 'synthetic-three-dml-50mb.log');
const targetBytes = 49_999_000;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

let fileBytes = 0;
let lineCount = 0;
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
  const buffer = Buffer.from(`${timestamp()}|${eventType}|${detail}\n`, 'utf8');
  if (fileBytes + buffer.length > targetBytes) return false;
  fs.writeSync(fileHandle, buffer);
  fileBytes += buffer.length;
  lineCount += 1;
  sequence += 1;
  return true;
}

function fillTo(targetAbsoluteBytes, objectName, dmlNumber) {
  let index = 0;
  while (fileBytes < targetAbsoluteBytes) {
    const recordNumber = dmlNumber * 1_000_000 + index;
    const ok = emit(
      'VARIABLE_ASSIGNMENT',
      `[${(index % 90) + 1}]|${objectName.toLowerCase()}Record${index % 8}|${objectName}:{Id=00QTEST${String(recordNumber).padStart(9, '0')},FirstName=Nested,LastName=Stress Record ${recordNumber},Company=Production Stress Corporation ${dmlNumber},Status=Open - Not Contacted,LeadSource=Web,Description=Large nested parser stress payload ${'X'.repeat(48)}`
    );
    if (!ok) break;
    index += 1;
  }
  return index;
}

function emitNestedEnvelope(objectName, dmlNumber, includeError) {
  const frames = [];
  for (let depth = 1; depth <= 6; depth += 1) {
    const triggerName = `${objectName}NestedTrigger${depth}`;
    const triggerId = `01qSTRESS${dmlNumber}${depth}`;
    const frame = { triggerName, triggerId, depth };
    frames.push(frame);
    if (!emit('CODE_UNIT_STARTED', `[TRIGGER]|${triggerId}|${triggerName} on ${objectName} trigger event AfterInsert`)) return false;
    if (!emit('METHOD_ENTRY', `[${depth + 10}]|${triggerId}|${triggerName}Handler.process(List<${objectName}>)`)) return false;
    if (!emit('FLOW_START_INTERVIEW_BEGIN', `[EXTERNAL]|Flow: ${objectName} Automation ${depth}|Interview Label: ${objectName} ${dmlNumber} Depth ${depth}`)) return false;
    if (!emit('FLOW_ELEMENT_BEGIN', `[EXTERNAL]|Flow${dmlNumber}${depth}|Get Records: Load related ${objectName} records`)) return false;
    if (!emit('SOQL_EXECUTE_BEGIN', `[${depth + 20}]|Aggregations:0|SELECT Id, Name FROM Account WHERE Name LIKE 'Stress%' LIMIT 5`)) return false;
    if (!emit('SOQL_EXECUTE_END', `[${depth + 20}]|Rows:5`)) return false;
    if (!emit('FLOW_ELEMENT_END', `[EXTERNAL]|Flow${dmlNumber}${depth}|Get Records: Load related ${objectName} records`)) return false;
    if (!emit('FLOW_ELEMENT_BEGIN', `[EXTERNAL]|Flow${dmlNumber}${depth}|Decision: Evaluate validation path`)) return false;
    if (includeError && depth === 6 && !emit('FLOW_ELEMENT_ERROR', `[EXTERNAL]|Flow${dmlNumber}${depth}|FIELD_CUSTOM_VALIDATION_EXCEPTION: Synthetic validation failure`)) return false;
    if (!emit('FLOW_ELEMENT_END', `[EXTERNAL]|Flow${dmlNumber}${depth}|Decision: Evaluate validation path`)) return false;
    if (!emit('FLOW_START_INTERVIEW_END', `[EXTERNAL]|Flow${dmlNumber}${depth}|${objectName} Automation ${depth}`)) return false;
    if (!emit('VALIDATION_RULE', `[${depth + 30}]|${objectName}: ${objectName}RequiredFields|Formula evaluated`)) return false;
    if (!emit(includeError && depth === 6 ? 'VALIDATION_FAIL' : 'VALIDATION_PASS', `[${depth + 30}]|${objectName}: ${objectName}RequiredFields|${includeError && depth === 6 ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Synthetic validation failure' : 'Validation passed'}`)) return false;
  }
  return frames;
}

function closeNestedEnvelope(frames) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!emit('METHOD_EXIT', `[${frame.depth + 10}]|${frame.triggerId}|${frame.triggerName}Handler.process(List<${frame.triggerName.replace(/NestedTrigger\d+$/, '')}>)`)) return false;
    if (!emit('CODE_UNIT_FINISHED', `[TRIGGER]|${frame.triggerId}|${frame.triggerName}`)) return false;
  }
  return true;
}

function emitNonDmlNestedSegment(segmentNumber, targetAbsoluteBytes) {
  const codeUnitId = `01pSTRESSSEG${segmentNumber}`;
  const flowId = `301STRESSSEG${segmentNumber}`;
  if (!emit('CODE_UNIT_STARTED', `[APEX_CODE]|${codeUnitId}|StressSegment${segmentNumber}.run()`)) return false;
  if (!emit('METHOD_ENTRY', `[${segmentNumber + 100}]|${codeUnitId}|StressSegment${segmentNumber}.run()`)) return false;
  if (!emit('FLOW_START_INTERVIEW_BEGIN', `[EXTERNAL]|Flow: Background Nested Events ${segmentNumber}|Interview Label: Background Stress ${segmentNumber}`)) return false;
  if (!emit('FLOW_ELEMENT_BEGIN', `[EXTERNAL]|${flowId}|Loop: Process related records`)) return false;
  fillTo(targetAbsoluteBytes, 'BackgroundEvent', segmentNumber);
  if (!emit('FLOW_ELEMENT_END', `[EXTERNAL]|${flowId}|Loop: Process related records`)) return false;
  if (!emit('FLOW_START_INTERVIEW_END', `[EXTERNAL]|${flowId}|Background Nested Events ${segmentNumber}`)) return false;
  if (!emit('METHOD_EXIT', `[${segmentNumber + 100}]|${codeUnitId}|StressSegment${segmentNumber}.run()`)) return false;
  if (!emit('CODE_UNIT_FINISHED', `[APEX_CODE]|${codeUnitId}|StressSegment${segmentNumber}.run()`)) return false;
  return true;
}

function emitSmallDml(objectName, operation, dmlNumber, includeError) {
  if (!emit('DML_BEGIN', `[${dmlNumber * 10}]|Op:${operation}|Type:${objectName}|Rows:200`)) return false;
  const frames = emitNestedEnvelope(objectName, dmlNumber, includeError);
  fillTo(fileBytes + 150_000, objectName, dmlNumber);
  closeNestedEnvelope(frames);
  return emit('DML_END', `[${dmlNumber * 10}]|Rows:200`);
}

emit('USER_DEBUG', '[1]|Synthetic 50 MB file with exactly three business DML events');
emit('CODE_UNIT_STARTED', '[EXTERNAL]|execute_anonymous_apex|ThreeCardStressTest');
emit('METHOD_ENTRY', '[1]|01pdSTRESS000000001|StressTestService.runNestedOperations()');

emitSmallDml('Lead', 'Insert', 1, false);
emitNonDmlNestedSegment(1, 16_650_000);
emitSmallDml('Contact', 'Update', 2, false);
emitNonDmlNestedSegment(2, 33_300_000);
emitSmallDml('Task', 'Upsert', 3, true);
emitNonDmlNestedSegment(3, targetBytes - 5_000);

emit('METHOD_EXIT', '[1]|01pdSTRESS000000001|StressTestService.runNestedOperations()');
emit('CODE_UNIT_FINISHED', '[EXTERNAL]|execute_anonymous_apex|ThreeCardStressTest');

fs.closeSync(fileHandle);

console.log(JSON.stringify({
  outputPath,
  bytes: fileBytes,
  megabytes: Number((fileBytes / 1_000_000).toFixed(2)),
  lines: lineCount,
  dmlBeginEvents: 3
}));

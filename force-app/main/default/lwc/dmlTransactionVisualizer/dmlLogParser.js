const BEGIN_END_MAP = {
  DML_BEGIN: 'DML_END',
  CODE_UNIT_STARTED: 'CODE_UNIT_FINISHED',
  SOQL_EXECUTE_BEGIN: 'SOQL_EXECUTE_END',
  SOSL_EXECUTE_BEGIN: 'SOSL_EXECUTE_END',
  FLOW_START_INTERVIEW_BEGIN: 'FLOW_START_INTERVIEW_END',
  FLOW_ELEMENT_BEGIN: 'FLOW_ELEMENT_END',
  METHOD_ENTRY: 'METHOD_EXIT',
  WF_RULE_EVAL_BEGIN: 'WF_RULE_EVAL_END',
  WF_CRITERIA_BEGIN: 'WF_CRITERIA_END',
  WF_FLOW_ACTION_BEGIN: 'WF_FLOW_ACTION_END'
};

const SINGLE_LINE_EVENTS = new Set([
  'VALIDATION_RULE',
  'VALIDATION_PASS',
  'VALIDATION_FAIL',
  'WF_RULE_FILTER',
  'WF_FIELD_UPDATE',
  'EXCEPTION_THROWN',
  'FATAL_ERROR',
  'FLOW_ELEMENT_ERROR',
  'USER_DEBUG'
]);

const DML_OPERATIONS = ['Insert', 'Update', 'Upsert', 'Delete', 'Undelete', 'Merge'];

const SYSTEM_METADATA_OBJECTS = new Set([
  'ApexClass',
  'ApexTrigger',
  'ApexPage',
  'ApexComponent',
  'ApexLog',
  'StaticResource',
  'AuraDefinition',
  'AuraDefinitionBundle',
  'ApexExecutionOverlayAction',
  'AsyncApexJob',
  'CronTrigger',
  'FlowInterview',
  'TraceFlag',
  'DebugLevel',
  'DebugLogController',
  'Unknown Object'
]);

function parseTimestampNanos(tsPart) {
  if (!tsPart) return null;
  const match = String(tsPart).match(/\((\d+)\)/);
  return match ? parseInt(match[1], 10) : null;
}

function parseTimestampString(tsPart) {
  if (!tsPart) return '-';
  const text = String(tsPart).trim();
  const timeWithMs = text.split(' ')[0] || text;
  return timeWithMs.split('.')[0] || timeWithMs;
}

function durationInMs(startNanos, endNanos) {
  if (startNanos === null || startNanos === undefined || endNanos === null || endNanos === undefined) {
    return null;
  }
  return ((endNanos - startNanos) / 1000000).toFixed(2);
}


function yieldToBrowser() {
  return new Promise((resolve) => {
    // Chunked parsing intentionally yields between batches to keep the UI responsive.
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(resolve, 0);
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Parsing cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * Chunked variant used by the LWC for large logs. The synchronous version is
 * intentionally kept for the parser unit tests and small callers.
 */
export async function buildExecutionTreeAsync(rawLog, options = {}) {
  if (!rawLog) {
    return { type: 'ROOT', children: [], isTruncated: false };
  }

  const isTruncated = rawLog.includes('*** MAXIMUM DEBUG LOG SIZE REACHED ***');
  const lines = rawLog.split(/\r?\n/);
  const root = { type: 'ROOT', children: [], isTruncated };
  const stack = [root];
  let sequence = 0;
  const chunkSize = Math.max(250, options.chunkSize || 1000);

  for (let start = 0; start < lines.length; start += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(start + chunkSize, lines.length);
    for (let index = start; index < end; index += 1) {
      if ((index - start) % 250 === 0) throwIfAborted(options.signal);
      const rawLine = lines[index];
      if (!rawLine.trim()) continue;
      const parts = rawLine.split('|');
      if (parts.length < 2) continue;

      const eventType = parts[1].trim();
      const eventNanos = parseTimestampNanos(parts[0]);
      if (Object.values(BEGIN_END_MAP).includes(eventType)) {
        let matchIndex = -1;
        for (let stackIndex = stack.length - 1; stackIndex > 0; stackIndex -= 1) {
          if (BEGIN_END_MAP[stack[stackIndex].type] === eventType) {
            matchIndex = stackIndex;
            break;
          }
        }
        if (matchIndex !== -1) {
          for (let stackIndex = stack.length - 1; stackIndex > matchIndex; stackIndex -= 1) {
            stack[stackIndex].incomplete = true;
            stack[stackIndex].endNanos = eventNanos;
            stack[stackIndex].endLine = index;
          }
          stack[matchIndex].endNanos = eventNanos;
          stack[matchIndex].endLine = index;
          stack.length = matchIndex;
        }
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(BEGIN_END_MAP, eventType) && !SINGLE_LINE_EVENTS.has(eventType)) {
        continue;
      }

      const node = {
        type: eventType,
        raw: rawLine,
        detail: parts.slice(2).join('|'),
        startNanos: eventNanos,
        timestampStr: parseTimestampString(parts[0]),
        sequence: sequence += 1,
        startLine: index,
        children: []
      };
      stack[stack.length - 1].children.push(node);
      if (Object.prototype.hasOwnProperty.call(BEGIN_END_MAP, eventType)) {
        stack.push(node);
      }
    }

    if (options.onProgress) {
      options.onProgress(end / lines.length);
    }
    if (end < lines.length) {
      // Chunk boundaries are intentionally processed sequentially.
      // eslint-disable-next-line no-await-in-loop
      await yieldToBrowser();
      throwIfAborted(options.signal);
    }
  }

  for (let index = 1; index < stack.length; index += 1) {
    stack[index].incomplete = true;
    stack[index].endLine = lines.length - 1;
  }
  captureUiSaveCandidates(root);
  pruneEmptyNodes(root);
  return root;
}

const WORK_EVENT_TYPES = new Set([
  'DML_BEGIN',
  'SOQL_EXECUTE_BEGIN',
  'SOSL_EXECUTE_BEGIN',
  'FLOW_START_INTERVIEW_BEGIN',
  'FLOW_ELEMENT_BEGIN',
  'FLOW_ELEMENT_ERROR',
  'USER_DEBUG',
  'EXCEPTION_THROWN',
  'FATAL_ERROR',
  // Keep successful automation evidence so it remains visible in the
  // selected DML tree. Error-only retention would hide passing rules.
  'VALIDATION_RULE',
  'VALIDATION_PASS',
  'VALIDATION_FAIL',
  'WF_FIELD_UPDATE',
  'WF_RULE_EVAL_BEGIN',
  'WF_CRITERIA_BEGIN',
  'WF_RULE_FILTER',
  'WF_FLOW_ACTION_BEGIN'
]);

export function pruneEmptyNodes(node) {
  if (!node) return null;

  if (node.children && node.children.length > 0) {
    node.children = node.children
      .map((child) => pruneEmptyNodes(child))
      .filter((child) => child !== null);
  }

  if (node.type === 'ROOT') {
    return node;
  }

  if (WORK_EVENT_TYPES.has(node.type)) {
    return node;
  }

  if (node.children && node.children.length > 0) {
    return node;
  }

  return null;
}

function extractTriggerEventPhase(detail) {
  const text = String(detail || '').toLowerCase();
  if (text.includes('beforeinsert')) return 'BEFORE INSERT';
  if (text.includes('afterinsert')) return 'AFTER INSERT';
  if (text.includes('beforeupdate')) return 'BEFORE UPDATE';
  if (text.includes('afterupdate')) return 'AFTER UPDATE';
  if (text.includes('beforedelete')) return 'BEFORE DELETE';
  if (text.includes('afterdelete')) return 'AFTER DELETE';
  if (text.includes('afterundelete')) return 'AFTER UNDELETE';
  return null;
}

function extractFlowEventPhase(detail) {
  const text = String(detail || '').toLowerCase();
  if (text.includes('beforesave') || text.includes('before save')) return 'BEFORE SAVE';
  if (text.includes('aftersave') || text.includes('after save')) return 'AFTER SAVE';
  if (text.includes('afterdelete') || text.includes('after delete')) return 'AFTER DELETE';
  if (text.includes('afterundelete') || text.includes('after undelete')) return 'AFTER UNDELETE';
  if (text.includes('beforedelete') || text.includes('before delete')) return 'BEFORE DELETE';
  return 'FLOW EXECUTION';
}

function extractDmlOpDetails(detail) {
  const text = String(detail || '');
  const rawOperation = text.match(/(?:^|\|)Op:([^|]+)/i)?.[1]?.trim();
  const operation = DML_OPERATIONS.find((value) => value.toLowerCase() === String(rawOperation || '').toLowerCase()) || 'Update';
  const objectName = text.match(/(?:^|\|)Type:([^|]+)/i)?.[1]?.trim() || 'Unknown Object';
  const rowCount = Number(text.match(/(?:^|\|)Rows:(\d+)/i)?.[1] || 1);
  return { operation, objectName, rowCount };
}

function treeHasError(node) {
  if (!node) return false;
  if (isErrorEvent(node.type)) {
    return true;
  }
  return (node.children || []).some((child) => treeHasError(child));
}

function isErrorEvent(type) {
  return type === 'EXCEPTION_THROWN' ||
    type === 'FATAL_ERROR' ||
    type === 'VALIDATION_FAIL' ||
    type === 'FLOW_ELEMENT_ERROR';
}

function statusFor(node) {
  // A log can contain multiple independent DML operations. Do not let an
  // error in a sibling DML frame turn this card into a false failure.
  return treeHasError(node) ? 'Failed' : 'Success';
}

function isInternalLoggingObject(objectName) {
  if (!objectName) return true;
  const name = String(objectName).trim();
  if (SYSTEM_METADATA_OBJECTS.has(name)) return true;
  if (name.startsWith('Apex') || name.startsWith('Aura') || name.endsWith('Event__e')) return true;
  return false;
}

function executionContextFrom(ancestors) {
  return (ancestors || [])
    .filter((ancestor) => ancestor.type === 'CODE_UNIT_STARTED' || ancestor.type.includes('FLOW'))
    .map((ancestor) => ({
      type: ancestor.type,
      detail: ancestor.detail,
      timestampStr: ancestor.timestampStr,
      startNanos: ancestor.startNanos,
      label: ancestor.type === 'CODE_UNIT_STARTED'
        ? (ancestor.detail?.includes('trigger') ? 'Trigger' : 'Apex Code Unit')
        : 'Flow Action',
      name: ancestor.detail?.split('|').pop() || ancestor.detail || 'Unknown context'
    }));
}

function collectErrorNodes(rootNode) {
  const errors = [];
  const stack = (rootNode?.children || []).slice();
  while (stack.length) {
    const node = stack.pop();
    if (isErrorEvent(node.type)) errors.push(node);
    for (const child of node.children || []) stack.push(child);
  }
  return errors;
}

function findRelatedErrors(rootNode, dmlNode, errorIndex = null) {
  if (!dmlNode) return [];
  const candidates = errorIndex || collectErrorNodes(rootNode);
  const startNanos = Number.isFinite(dmlNode.startNanos) ? dmlNode.startNanos : null;
  const endNanos = Number.isFinite(dmlNode.endNanos) ? dmlNode.endNanos : null;
  const startLine = Number.isFinite(dmlNode.startLine) ? dmlNode.startLine : null;
  const endLine = Number.isFinite(dmlNode.endLine) ? dmlNode.endLine : null;
  const scoped = candidates.filter((candidate) => {
    if (Number.isFinite(candidate.startNanos) && startNanos !== null) {
      return candidate.startNanos >= startNanos && (endNanos === null || candidate.startNanos <= endNanos);
    }
    if (Number.isFinite(candidate.startLine) && startLine !== null) {
      return candidate.startLine >= startLine && (endLine === null || candidate.startLine <= endLine);
    }
    return false;
  });
  if (scoped.length || errorIndex) return scoped;
  return collectErrorNodes(dmlNode);
}

function cardFromNode(node, cardIndex, fields, ancestors = [], rootNode = null, errorIndex = null) {
  const id = `${fields.kind}-${node.sequence || cardIndex + 1}`;
  const relatedErrors = findRelatedErrors(rootNode, node, errorIndex);
  const directActions = summarizeChildren(node.children || [], id, 1);
  const automationActions = summarizePostSaveAutomation(fields.relatedAutomationNodes || [], id);
  const nodeHasError = treeHasError(node);
  const unhandledErrors = nodeHasError ? [] : relatedErrors;
  const errorActions = summarizeChildren(unhandledErrors, id, 1);
  const actions = [...directActions, ...errorActions, ...automationActions];
  const durationMs = durationInMs(node.startNanos, node.endNanos);
  const contextEvents = executionContextFrom(ancestors);
  const hasErr = relatedErrors.length > 0 || nodeHasError;

  return {
    id,
    Transaction_Id__c: node.timestampStr || `LOG-DML-${cardIndex + 1}`,
    timestampStr: node.timestampStr || '-',
    Object_API_Name__c: fields.objectName,
    DML_Type__c: fields.operation,
    rowCount: fields.rowCount || 1,
    Status__c: hasErr ? 'Failed' : statusFor(node),
    Error_Message__c: relatedErrors[0]?.detail || null,
    durationMs,
    durationLabel: durationMs ? `${durationMs} ms` : 'N/A',
    incomplete: Boolean(node.incomplete),
    isConfirmed: fields.isConfirmed !== false && !fields.isInferred,
    isInferred: Boolean(fields.isInferred),
    inferenceReason: fields.inferenceReason || null,
    ancestorBreadcrumbs: contextEvents,
    dmlScope: {
      startNanos: node.startNanos,
      endNanos: node.endNanos,
      startLine: node.startLine,
      endLine: node.endLine,
      objectName: fields.objectName,
      operation: fields.operation,
      rowCount: fields.rowCount || 1,
      contextEvents
    },
    actions,
    hasActions: actions.length > 0
  };
}

function walkTree(node, visitor, ancestors = []) {
  for (const child of node.children || []) {
    visitor(child, ancestors);
    walkTree(child, visitor, [...ancestors, child]);
  }
}

async function walkTreeAsync(node, visitor, options = {}) {
  const stack = (node?.children || []).slice().reverse().map((child) => ({
    node: child,
    ancestors: []
  }));
  const yieldEvery = Math.max(100, options.yieldEvery || 500);
  let visited = 0;

  while (stack.length) {
    throwIfAborted(options.signal);
    const current = stack.pop();
    visitor(current.node, current.ancestors);
    visited += 1;

    const children = current.node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        ancestors: [...current.ancestors, current.node]
      });
    }

    if (visited % yieldEvery === 0 && stack.length) {
      // Tree traversal is intentionally chunked and sequential so cancellation can be checked.
      // eslint-disable-next-line no-await-in-loop
      await yieldToBrowser();
      throwIfAborted(options.signal);
    }
  }
}

function operationFromTriggerEvent(eventName) {
  const normalized = String(eventName || '').toLowerCase();
  if (normalized.includes('undelete')) return 'Undelete';
  if (normalized.includes('delete')) return 'Delete';
  if (normalized.includes('update')) return 'Update';
  if (normalized.includes('insert')) return 'Insert';
  return 'Insert';
}

function isBusinessTriggerNode(node) {
  return node?.type === 'CODE_UNIT_STARTED' && /\btrigger\s+event\b/i.test(node.detail || '');
}

function codeUnitName(node) {
  return String(node?.detail || '').split('|').pop().trim();
}

function isPostSaveAutomationNode(node) {
  if (!node) return false;
  if (node.type === 'FLOW_START_INTERVIEW_BEGIN' || node.type === 'FLOW_ELEMENT_BEGIN') return true;
  if (node.type !== 'CODE_UNIT_STARTED') return false;
  return /^(?:Workflow|Flow):/i.test(codeUnitName(node)) || /^SLA$/i.test(codeUnitName(node));
}

function relatedPostSaveAutomation(rootNode, triggerNode) {
  const rootChildren = rootNode?.children || [];
  const triggerIndex = rootChildren.indexOf(triggerNode);
  if (triggerIndex < 0) return [];

  const automationNodes = [];
  for (let index = triggerIndex + 1; index < rootChildren.length; index += 1) {
    const candidate = rootChildren[index];
    if (candidate.type === 'DML_BEGIN' || isBusinessTriggerNode(candidate)) {
      break;
    }
    if (isPostSaveAutomationNode(candidate)) {
      automationNodes.push(candidate);
      continue;
    }
    // Root execution frames are ordered. A different root frame means this
    // post-save automation sequence has ended; never attach unrelated work.
    if (candidate.type === 'CODE_UNIT_STARTED' || candidate.type.includes('FLOW')) {
      break;
    }
  }
  return automationNodes;
}

function cloneInferenceNode(node) {
  return {
    ...node,
    children: (node.children || []).map((child) => cloneInferenceNode(child))
  };
}

function captureUiSaveCandidates(rootNode) {
  const candidates = [];
  walkTree(rootNode, (node) => {
    if (!isBusinessTriggerNode(node)) return;
    const triggerMatch = String(node.detail || '').match(/\bon\s+([A-Za-z0-9_]+)\s+trigger\s+event\s+([A-Za-z0-9_]+)/i);
    if (!triggerMatch || isInternalLoggingObject(triggerMatch[1])) return;
    candidates.push({
      triggerNode: node,
      relatedAutomationNodes: relatedPostSaveAutomation(rootNode, node).map((candidate) => cloneInferenceNode(candidate))
    });
  });
  rootNode.inferredUiSaveCandidates = candidates;
}

function findInferredUiCard(rootNode, cardIndex) {
  const savedCandidates = rootNode?.inferredUiSaveCandidates || [];
  if (savedCandidates.length > 0) {
    const candidate = savedCandidates[0];
    const triggerMatch = String(candidate.triggerNode?.detail || '').match(/\bon\s+([A-Za-z0-9_]+)\s+trigger\s+event\s+([A-Za-z0-9_]+)/i);
    if (triggerMatch && !isInternalLoggingObject(triggerMatch[1])) {
      return cardFromNode(candidate.triggerNode, cardIndex, {
        kind: 'trigger',
        objectName: triggerMatch[1],
        operation: operationFromTriggerEvent(triggerMatch[2]),
        rowCount: 1,
        isInferred: true,
        inferenceReason: 'Derived from Trigger event execution in Lightning UI.',
        relatedAutomationNodes: candidate.relatedAutomationNodes
      });
    }
  }

  let triggerNode;
  let triggerObject;
  let triggerOperation;

  walkTree(rootNode, (node) => {
    if (node.type !== 'CODE_UNIT_STARTED' || !node.detail) {
      return;
    }

    const triggerMatch = node.detail.match(/\bon\s+([A-Za-z0-9_]+)\s+trigger\s+event\s+([A-Za-z0-9_]+)/i);
    if (triggerMatch && !triggerNode) {
      const obj = triggerMatch[1];
      if (!isInternalLoggingObject(obj)) {
        triggerNode = node;
        triggerObject = obj;
        triggerOperation = operationFromTriggerEvent(triggerMatch[2]);
      }
    }
  });

  if (triggerNode) {
    return cardFromNode(triggerNode, cardIndex, {
      kind: 'trigger',
      objectName: triggerObject,
      operation: triggerOperation,
      rowCount: 1,
      isInferred: true,
      inferenceReason: 'Derived from Trigger event execution in Lightning UI.',
      relatedAutomationNodes: relatedPostSaveAutomation(rootNode, triggerNode)
    });
  }

  return null;
}

export async function extractDmlCardResult(rootNode, options = { includeInferredUiSaves: true }) {
  if (!rootNode?.children) {
    return { cards: [], confirmedDmlCount: 0, internalDmlCount: 0 };
  }

  const cards = [];
  let confirmedDmlCount = 0;
  let internalDmlCount = 0;
  const errorIndex = collectErrorNodes(rootNode);
  await walkTreeAsync(rootNode, (node, ancestors) => {
    if (node.type !== 'DML_BEGIN') {
      return;
    }

    const details = extractDmlOpDetails(node.detail);
    if (details.operation === 'Unknown' || details.objectName === 'Unknown Object') {
      return;
    }

    confirmedDmlCount += 1;
    if (isInternalLoggingObject(details.objectName)) {
      internalDmlCount += 1;
      return;
    }

    cards.push({
      ...cardFromNode(node, cards.length, {
        kind: 'dml',
        objectName: details.objectName,
        operation: details.operation,
        rowCount: details.rowCount,
        isConfirmed: true
      }, ancestors, rootNode, errorIndex),
      sourceEvent: 'DML_BEGIN'
    });
  }, { signal: options.signal });

  // Layer 2: Trigger fallback scan for Lightning UI saves if DML_BEGIN absent
  const allowInferred = options.includeInferredUiSaves !== false;
  if (!cards.length && allowInferred) {
    const inferredCard = findInferredUiCard(rootNode, cards.length);
    if (inferredCard && !isInternalLoggingObject(inferredCard.Object_API_Name__c)) {
      cards.push(inferredCard);
    }
  }

  return { cards, confirmedDmlCount, internalDmlCount };
}

const OBJECT_KEY_PREFIXES = {
  Account: '001',
  Contact: '003',
  Opportunity: '006',
  Lead: '00Q',
  Task: '00T',
  Case: '500',
  Asset: '02i',
  Campaign: '701',
  Contract: '800',
  Order: '801',
  User: '005'
};

const REVERSE_PREFIX_MAP = Object.fromEntries(
  Object.entries(OBJECT_KEY_PREFIXES).map(([objectName, prefix]) => [prefix, objectName])
);

function getObjectFromIdOrVar(recordId, varName) {
  if (recordId && recordId.length >= 3) {
    const prefix = recordId.substring(0, 3);
    if (REVERSE_PREFIX_MAP[prefix]) {
      return REVERSE_PREFIX_MAP[prefix];
    }
  }
  if (varName) {
    const lower = String(varName).toLowerCase();
    if (lower.includes('lead')) return 'Lead';
    if (lower.includes('task')) return 'Task';
    if (lower.includes('account')) return 'Account';
    if (lower.includes('contact')) return 'Contact';
    if (lower.includes('opp')) return 'Opportunity';
    if (lower.includes('case')) return 'Case';
  }
  // Do not attach an unidentifiable assignment to the selected DML object.
  // Nested automation can assign fields on a different sObject, so using the
  // outer DML object as a fallback creates false field changes.
  return null;
}

export function getScopedLogLines(rawLog, dmlScope = null) {
  const text = String(rawLog || '');
  const startLine = Number.isFinite(dmlScope?.startLine) ? Math.max(0, dmlScope.startLine) : null;
  const endLine = Number.isFinite(dmlScope?.endLine) ? Math.max(startLine ?? 0, dmlScope.endLine) : null;
  if (startLine === null && endLine === null) {
    return text.split(/\r?\n/).map((rawLine, lineIndex) => ({ rawLine, lineIndex }));
  }

  const lines = [];
  let lineStart = 0;
  let lineIndex = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const isEnd = index === text.length;
    if (!isEnd && text.charCodeAt(index) !== 10) continue;
    if (lineIndex >= (startLine ?? 0) && (endLine === null || lineIndex <= endLine)) {
      const rawLine = text.slice(lineStart, index).replace(/\r$/, '');
      lines.push({ rawLine, lineIndex });
    }
    if (endLine !== null && lineIndex >= endLine) break;
    lineIndex += 1;
    lineStart = index + 1;
  }
  return lines;
}

export async function extractFieldChangesFromDebugLog(rawLog, dmlScope = null, options = {}) {
  if (!rawLog) return { groups: [], flat: [] };

  const lines = getScopedLogLines(rawLog, dmlScope);
  const seenFields = new Set();
  const groupsMap = new Map(); // Key: objectName:recordId
  const previousSnapshots = new Map();
  const generatedRecordIds = new Map();
  const knownRecordIds = new Map();

  function getRecordIdForObject(objName, fallbackId) {
    if (fallbackId && fallbackId.length >= 15 && !fallbackId.includes(' ')) {
      const objFromId = getObjectFromIdOrVar(fallbackId);
      if (objFromId === objName) {
        knownRecordIds.set(objName, fallbackId);
        const generatedId = generatedRecordIds.get(objName || 'SObject');
        const generatedKey = `${objName}:${generatedId}`;
        const realKey = `${objName}:${fallbackId}`;
        const generatedGroup = groupsMap.get(generatedKey);
        const realGroup = groupsMap.get(realKey);

        if (generatedGroup && !realGroup) {
          generatedGroup.groupKey = realKey;
          generatedGroup.recordId = fallbackId;
          generatedGroup.isRealId = true;
          generatedGroup.recordUrl = `/lightning/r/${objName}/${fallbackId}/view`;
          generatedGroup.changes.forEach((change) => {
            change.Record_Id__c = fallbackId;
          });
          groupsMap.delete(generatedKey);
          groupsMap.set(realKey, generatedGroup);
        } else if (generatedGroup && realGroup) {
          const mergedChanges = [...generatedGroup.changes, ...realGroup.changes].map((change) => ({
            ...change,
            Record_Id__c: fallbackId
          }));
          const changesByField = new Map();
          mergedChanges.forEach((change) => changesByField.set(change.Field_API_Name__c, change));
          realGroup.changes = Array.from(changesByField.values()).map((change, index) => ({
            ...change,
            Id: `change-${index + 1}`
          }));
          groupsMap.delete(generatedKey);
        }
        return fallbackId;
      }
    }
    const knownId = knownRecordIds.get(objName);
    if (knownId) return knownId;
    const generatedKey = objName || 'SObject';
    if (!generatedRecordIds.has(generatedKey)) {
      generatedRecordIds.set(generatedKey, `(New ${generatedKey})`);
    }
    return generatedRecordIds.get(generatedKey);
  }

  function addFieldChange(objName, rawRecId, field, oldValue, newValue, typeStr) {
    const recId = getRecordIdForObject(objName, rawRecId);
    const fieldKey = `${objName}:${recId}:${field}:${oldValue}:${newValue}`;
    if (seenFields.has(fieldKey)) return;
    seenFields.add(fieldKey);

    const groupKey = `${objName}:${recId}`;
    if (!groupsMap.has(groupKey)) {
      const isRealId = recId && recId.length >= 15 && !recId.includes(' ');
      groupsMap.set(groupKey, {
        groupKey,
        objectName: objName,
        recordId: recId,
        recordUrl: isRealId ? `/lightning/r/${objName}/${recId}/view` : null,
        isRealId,
        changes: []
      });
    }

    const grp = groupsMap.get(groupKey);
    const existingChange = grp.changes.find((change) => change.Field_API_Name__c === field);
    if (existingChange) {
      existingChange.Old_Value__c = existingChange.Old_Value__c === '-' ? oldValue : existingChange.Old_Value__c;
      existingChange.New_Value__c = newValue;
      existingChange.Field_Type__c = typeStr;
      return;
    }
    grp.changes.push({
      Id: `change-${grp.changes.length + 1}`,
      Record_Id__c: recId,
      Field_API_Name__c: field,
      Old_Value__c: oldValue,
      New_Value__c: newValue,
      Field_Type__c: typeStr
    });
  }

  for (let lineOffset = 0; lineOffset < lines.length; lineOffset += 1) {
    const { rawLine, lineIndex } = lines[lineOffset];
    if (lineOffset % 250 === 0) throwIfAborted(options.signal);
    if (lineOffset > 0 && lineOffset % 500 === 0) {
      // Field-change parsing is intentionally chunked and sequential.
      // eslint-disable-next-line no-await-in-loop
      await yieldToBrowser();
      throwIfAborted(options.signal);
    }
    if (!rawLine.trim()) continue;

    if (Number.isFinite(dmlScope?.startLine) && lineIndex < dmlScope.startLine) continue;
    if (Number.isFinite(dmlScope?.endLine) && lineIndex > dmlScope.endLine) continue;

    const lineNanos = parseTimestampNanos(rawLine.split('|')[0]);
    if (Number.isFinite(dmlScope?.startNanos) && Number.isFinite(lineNanos) &&
        (lineNanos < dmlScope.startNanos || (Number.isFinite(dmlScope.endNanos) && lineNanos > dmlScope.endNanos))) {
      continue;
    }

    if (rawLine.includes('VARIABLE_ASSIGNMENT')) {
      const parts = rawLine.split('|');
      if (parts.length >= 5) {
        const varName = parts[3] || '';
        const valText = parts[4] || '';

        if (valText.startsWith('{') && valText.endsWith('}') && valText.includes(':')) {
          try {
            const jsonObj = JSON.parse(valText);
            const objName = getObjectFromIdOrVar(jsonObj.Id, varName, dmlScope);
            const recId = jsonObj.Id;
            if (!objName) continue;

            const snapshotKey = `${objName}:${recId || '(new)'}`;
            const previous = previousSnapshots.get(snapshotKey) || {};
            previousSnapshots.set(snapshotKey, { ...previous, ...jsonObj });

            Object.keys(jsonObj).forEach((field) => {
              if (field === 'attributes' || field === 'Id') return;
              const val = jsonObj[field];
              if (val === null || val === undefined) return;

              const oldVal = previous[field];
              const oldStr = oldVal === null || oldVal === undefined ? '-' : typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal);
              const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
              if (oldStr === valStr) return;
              const typeStr = typeof val === 'number' ? 'Number' : typeof val === 'boolean' ? 'Boolean' : 'String';
              addFieldChange(objName, recId, field, oldStr, valStr, typeStr);
            });
          } catch {
            // Ignore non-json
          }
        } else if (varName.includes('.')) {
          const fieldParts = varName.split('.');
          const field = fieldParts[fieldParts.length - 1];
          const valStr = valText.replace(/^"|"$/g, '').trim();
          const objName = getObjectFromIdOrVar(null, varName, dmlScope);

          if (objName && field && valStr) {
            addFieldChange(objName, null, field, '-', valStr, 'String');
          }
        }
      }
    }

  }

  const groups = Array.from(groupsMap.values()).map((grp) => ({
    ...grp,
    fieldCount: grp.changes.length
  }));

  const flat = groups.flatMap((g) => g.changes);

  return { groups, flat, defaultStep: flat };
}

export async function extractDmlCards(rootNode, options = { includeInferredUiSaves: true }) {
  const result = await extractDmlCardResult(rootNode, options);
  return result.cards;
}

function parseValidationEventDetails(type, detail, previousRuleName = null) {
  const segments = String(detail || '')
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !/^\[?\d+\]?$/.test(segment));
  const status = type === 'VALIDATION_PASS'
    ? 'Passed'
    : type === 'VALIDATION_FAIL'
      ? 'Failed'
      : 'Evaluated';
  const statusPattern = /^(?:validation\s+)?(?:passed|pass|failed|fail|error|formula\s+evaluated)$/i;
  const nameSegment = segments.find((segment) => {
    if (statusPattern.test(segment)) return false;
    if (type === 'VALIDATION_RULE') return true;
    return /^[A-Za-z][A-Za-z0-9 _-]*\s*:\s*\S/.test(segment);
  });
  let ruleName = nameSegment || previousRuleName || null;
  if (nameSegment && nameSegment.includes(':')) {
    const qualifiedName = nameSegment.split(':').slice(1).join(':').trim();
    if (qualifiedName) ruleName = qualifiedName;
  }
  const detailSegments = segments.filter((segment) => segment !== nameSegment);
  return {
    ruleName,
    status,
    detail: detailSegments.join(' | ') || null
  };
}

function summarizeChildren(children, parentId = 'root', depth = 1, previousValidationRule = null) {
  if (!children?.length) {
    return [];
  }

  const displayChildren = aggregateRepeatedActions(children);
  let lastValidationRule = previousValidationRule;

  return displayChildren.map((entry, idx) => {
    const c = entry.node;
    const nodeId = `${parentId}-${idx}`;
    const durationStr = durationInMs(c.startNanos, c.endNanos);
    const hasChildren = Boolean(c.children && c.children.length > 0);
    const base = {
      key: nodeId,
      type: c.type,
      durationMs: durationStr,
      durationLabel: durationStr ? `${durationStr} ms` : '',
      timestamp: c.timestampStr || '-',
      incomplete: Boolean(c.incomplete),
      hasChildren,
      repeatCount: entry.repeatCount,
      defaultExpanded: depth === 1,
      showTypeBadge: true,
      badgeClass: getBadgeClass(c.type, c.incomplete),
      iconName: getIconName(c.type)
    };

    switch (c.type) {
      case 'CODE_UNIT_STARTED':
        {
          const unitName = codeUnitName(c);
          if (c.detail && c.detail.includes('trigger')) {
            base.label = 'Trigger';
            const phase = extractTriggerEventPhase(c.detail);
            if (phase) {
              base.eventPhase = phase;
              base.phaseBadgeClass = phase.includes('BEFORE') ? 'phase-badge badge-before' : 'phase-badge badge-after';
            }
          } else if (/^Flow:/i.test(unitName)) {
            base.label = 'Record-Triggered Flow';
            base.eventPhase = extractFlowEventPhase(c.detail);
            base.phaseBadgeClass = base.eventPhase.includes('BEFORE')
              ? 'phase-badge badge-before'
              : base.eventPhase.includes('AFTER')
                ? 'phase-badge badge-after'
                : 'phase-badge badge-flow';
          } else if (/^Workflow:/i.test(unitName)) {
            base.label = 'Workflow';
          } else if (/^SLA$/i.test(unitName)) {
            base.label = 'SLA Automation';
          } else {
            base.label = 'Apex Code Unit';
          }
          base.name = unitName;
          break;
        }
      case 'SOQL_EXECUTE_BEGIN':
        base.label = 'SOQL Query';
        base.name = c.detail.split('|').pop();
        break;
      case 'SOSL_EXECUTE_BEGIN':
        base.label = 'SOSL Query';
        base.name = c.detail.split('|').pop();
        break;
      case 'FLOW_START_INTERVIEW_BEGIN':
        base.label = 'Flow Interview';
        base.name = c.detail.split('|').pop();
        break;
      case 'FLOW_ELEMENT_BEGIN':
        base.label = 'Flow Element';
        base.name = c.detail.split('|').pop();
        break;
      case 'FLOW_ELEMENT_ERROR':
        base.label = 'Flow Error';
        base.name = c.detail;
        base.badgeClass = 'slds-badge slds-theme_error';
        break;
      case 'USER_DEBUG':
        base.label = 'Debug Message';
        base.name = c.detail;
        base.badgeClass = 'slds-badge slds-theme_info';
        break;
      case 'DML_BEGIN': {
        const nested = extractDmlOpDetails(c.detail);
        base.label = 'Nested DML';
        base.name = `${nested.operation} ${nested.objectName} (${nested.rowCount} rows)`;
        break;
      }
      case 'VALIDATION_RULE':
      case 'VALIDATION_PASS':
      case 'VALIDATION_FAIL':
        {
          const validation = parseValidationEventDetails(c.type, c.detail, lastValidationRule);
          if (validation.ruleName) lastValidationRule = validation.ruleName;
          base.validationRuleName = validation.ruleName;
          base.validationStatus = validation.status;
          base.validationDetail = validation.detail;
          base.label = 'Validation Rule';
          base.name = validation.ruleName
            ? `${validation.ruleName}${validation.detail ? ` — ${validation.detail}` : ''}`
            : (validation.detail || 'Validation rule name unavailable');
          break;
        }
      case 'WF_FIELD_UPDATE':
      case 'WF_RULE_EVAL_BEGIN':
        base.label = 'Workflow Update';
        base.name = c.detail.split('|').pop();
        break;
      case 'WF_CRITERIA_BEGIN':
        base.label = 'Workflow Criteria';
        base.name = c.detail.split('|').pop();
        break;
      case 'WF_RULE_FILTER':
        base.label = 'Workflow Filter';
        base.name = c.detail.split('|').pop();
        break;
      case 'WF_FLOW_ACTION_BEGIN':
        base.label = 'Workflow Action';
        base.name = c.detail.split('|').pop();
        break;
      case 'EXCEPTION_THROWN':
      case 'FATAL_ERROR':
        base.label = 'Exception / Error';
        base.name = c.detail;
        base.badgeClass = 'slds-badge slds-theme_error';
        break;
      default:
        base.label = c.type.replace(/_/g, ' ');
        base.name = c.detail;
    }

    if (entry.repeatCount > 1) {
      base.name = `${base.name || c.detail || c.type} x ${entry.repeatCount}`;
    }

    if (hasChildren) {
      base.children = summarizeChildren(c.children, nodeId, depth + 1, lastValidationRule);
    }
    return base;
  });
}

function aggregateRepeatedActions(children) {
  const result = [];
  let previous = null;

  for (const node of children || []) {
    const canAggregate = node.type === 'FLOW_START_INTERVIEW_BEGIN' ||
      node.type === 'FLOW_ELEMENT_BEGIN' ||
      (node.type === 'CODE_UNIT_STARTED' && /^(Flow:|Validation:)/i.test(codeUnitName(node)));
    const signature = canAggregate ? `${node.type}|${normalizeRepeatedActionDetail(node)}` : null;

    if (previous && signature && previous.signature === signature) {
      previous.repeatCount += 1;
      previous.node.endNanos = node.endNanos || previous.node.endNanos;
      previous.node.incomplete = previous.node.incomplete || node.incomplete;
      continue;
    }

    previous = { node, signature, repeatCount: 1 };
    result.push(previous);
  }

  return result;
}

function normalizeRepeatedActionDetail(node) {
  const detail = String(node.detail || '');
  if (node.type === 'FLOW_START_INTERVIEW_BEGIN' || node.type === 'FLOW_ELEMENT_BEGIN') {
    const parts = detail.split('|');
    return parts.length > 1 ? parts.slice(1).join('|') : detail;
  }
  return node.type === 'CODE_UNIT_STARTED' ? codeUnitName(node) : detail;
}

function summarizePostSaveAutomation(nodes, parentId) {
  if (!nodes.length) return [];
  const nodeId = `${parentId}-post-save-automation`;
  return [{
    key: nodeId,
    type: 'POST_SAVE_AUTOMATION',
    label: 'Related Automation',
    name: 'Workflow, record-triggered Flow, and SLA actions related to this save',
    timestamp: nodes[0].timestampStr || '-',
    durationMs: null,
    durationLabel: '',
    incomplete: nodes.some((node) => node.incomplete),
    hasChildren: true,
    defaultExpanded: true,
    showTypeBadge: false,
    badgeClass: 'slds-badge slds-theme_warning',
    iconName: 'utility:automation',
    children: summarizeChildren(nodes, nodeId, 2)
  }];
}

function getBadgeClass(type, incomplete) {
  if (incomplete || isErrorEvent(type)) {
    return 'slds-badge slds-theme_error';
  }
  if (type === 'DML_BEGIN') return 'slds-badge slds-theme_success';
  if (type === 'SOQL_EXECUTE_BEGIN') return 'slds-badge slds-theme_info';
  if (type.includes('FLOW')) return 'slds-badge slds-theme_warning';
  return 'slds-badge';
}

function getIconName(type) {
  if (type === 'DML_BEGIN') return 'utility:database';
  if (type === 'SOQL_EXECUTE_BEGIN' || type === 'SOSL_EXECUTE_BEGIN') return 'utility:search';
  if (type === 'FLOW_ELEMENT_ERROR') return 'utility:error';
  if (type === 'USER_DEBUG') return 'utility:info';
  if (type.includes('FLOW')) return 'utility:flow';
  if (type.includes('CODE_UNIT')) return 'utility:apex';
  if (type.includes('VALIDATION')) return 'utility:warning';
  if (type.includes('EXCEPTION') || type.includes('ERROR')) return 'utility:error';
  return 'utility:chevronright';
}

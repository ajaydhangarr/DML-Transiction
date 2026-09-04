import { LightningElement, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import dmlLogParserFrameUrl from '@salesforce/resourceUrl/dmlLogParserFrame';
import getQueueLogs from '@salesforce/apex/DebugLogController.getQueueLogs';
import fetchLogBody from '@salesforce/apex/DebugLogController.fetchLogBody';
import {
    buildExecutionTreeAsync,
    extractDmlCardResult,
    extractFieldChangesFromDebugLog,
    getScopedLogLines
} from './dmlLogParser.js';

const MAX_FETCHABLE_LOG_BYTES = 6000000;
const MAX_UPLOAD_BYTES = 60000000;
const MAX_RAW_LOG_CACHE_ENTRIES = 2;
const MAX_DETAIL_CACHE_ENTRIES = 8;
const MAX_UPLOADED_SCOPE_CACHE_ENTRIES = 3;
const TREE_READY_TIMEOUT_MS = 5000;
const UPLOADED_PARSER_READY_TIMEOUT_MS = 10000;
const UPLOADED_PARSER_REQUEST_TIMEOUT_MS = 120000;
const REMOTE_REQUEST_TIMEOUT_MS = 120000;
const FIELD_GROUP_PAGE_SIZE = 1;
const QUEUE_PAGE_SIZE = 100;
const MAX_DEBUG_ONLY_NODES = 5000;
let queueSnapshot;

export default class DmlTransactionVisualizer extends LightningElement {
    loading = false;
    loadingToken = 0;
    queueLoading = false;
    transactions = [];
    debugLogs = [];
    parsedDebugEvents = [];
    debugLogBodies = new Map();
    debugLogTrees = new Map();
    debugLogCardResults = new Map();
    detailCache = new Map();
    scanSessionId = 0;
    scanPendingCount = 0;
    blockedLogCount = 0;
    debugLogError = '';
    queueStats = { logCount: 0, businessCardCount: 0, confirmedDmlCount: 0, internalDmlCount: 0 };
    detail = {};
    selectedId;
    selectedStepId;
    selectedHealthEventKey;
    fieldGroupPage = 1;
    selectedFieldGroupKey;
    detailRequestToken = 0;
    detailLoadingToken = 0;
    detailAbortController = null;
    @track filters = { objectName: 'All', status: 'All', dmlType: 'All' };
    uploadState = 'idle';
    uploadProgress = 0;
    uploadFileName = '';
    uploadMessage = '';
    uploadedFile = null;
    uploadedScopeCache = new Map();
    uploadedParserFrame = null;
    uploadedParserFrameReady = false;
    uploadedParserFrameOrigin = null;
    uploadedParserFrameResolvers = [];
    uploadedParserMessageHandler = (event) => this.handleUploadedParserMessage(event);
    uploadedWorkerPending = null;
    uploadedWorkerRequestId = 0;
    uploadedParseSession = 0;
    activeInspectorTab = 'details';
    detailLoading = false;
    tabLoading = false;
    treeLoading = false;
    treeRenderTimedOut = false;
    treeReadyTimeoutId = null;
    treeRenderToken = 0;
    activeTreeRenderToken = 0;
    scanAbortController = null;
    uploadedAbortController = null;
    queueVisibleCount = QUEUE_PAGE_SIZE;
    stepsCacheDetail = null;
    stepsCacheSelectedId = null;
    stepsCacheValue = [];
    importantEventsCacheDetail = null;
    importantEventsCacheSelectedId = null;
    importantEventsCacheHealthKey = null;
    importantEventsCacheValue = [];
    displayActionsCacheInput = null;
    displayActionsCacheDebugOnly = null;
    displayActionsCacheValue = [];
    selectedCardCacheTransactions = null;
    selectedCardCacheDetail = null;
    selectedCardCacheId = null;
    selectedCardCacheValue = null;

    objectOptions = [{ label: 'All Objects', value: 'All' }];
    statusOptions = [
        { label: 'All', value: 'All' },
        { label: 'Success', value: 'Success' },
        { label: 'Failed', value: 'Failed' }
    ];
    dmlOptions = [
        { label: 'All', value: 'All' },
        { label: 'Insert', value: 'Insert' },
        { label: 'Update', value: 'Update' },
        { label: 'Delete', value: 'Delete' },
        { label: 'Undelete', value: 'Undelete' },
        { label: 'Upsert', value: 'Upsert' },
        { label: 'Merge', value: 'Merge' }
    ];
    fieldColumns = [
        { label: 'Field', fieldName: 'Field_API_Name__c' },
        { label: 'Old Value', fieldName: 'Old_Value__c', wrapText: true },
        { label: 'New Value', fieldName: 'New_Value__c', wrapText: true },
        { label: 'Type', fieldName: 'Field_Type__c' }
    ];

    connectedCallback() {
        this.uploadedParserFrameOrigin = new URL(dmlLogParserFrameUrl, window.location.href).origin;
        window.addEventListener('message', this.uploadedParserMessageHandler);
        if (queueSnapshot) {
            if (Number(queueSnapshot.scanPendingCount || 0) === 0) {
                this.restoreQueueSnapshot();
            } else {
                queueSnapshot = undefined;
                this.loadTransactions();
            }
            return;
        }
        this.loadTransactions();
    }

    disconnectedCallback() {
        this.scanSessionId += 1;
        this.scanAbortController?.abort();
        this.uploadedAbortController?.abort();
        this.clearTreeReadyTimeout();
        this.destroyUploadedWorker();
        this.cancelActiveDetailParse();
        window.removeEventListener('message', this.uploadedParserMessageHandler);
    }

    get hasTransactions() {
        return this.transactions.length > 0;
    }

    beginGlobalLoading() {
        const token = ++this.loadingToken;
        this.loading = true;
        return token;
    }

    endGlobalLoading(token) {
        if (token === this.loadingToken) {
            this.loading = false;
        }
    }

    get visibleTransactions() {
        return this.transactions.slice(0, this.queueVisibleCount);
    }

    get hasMoreTransactions() {
        return this.transactions.length > this.queueVisibleCount;
    }

    loadMoreQueueRows() {
        this.queueVisibleCount += QUEUE_PAGE_SIZE;
    }

    get isUploadingFile() {
        return this.uploadState === 'reading' || this.uploadState === 'parsing';
    }

    get uploadProgressLabel() {
        return `${Math.round(this.uploadProgress)}%`;
    }

    get uploadStatusClass() {
        const state = ['reading', 'parsing', 'ready', 'error'].includes(this.uploadState)
            ? this.uploadState
            : 'idle';
        return `file-upload-status is-${state}`;
    }

    get isExecutionTreeTabActive() {
        return this.activeInspectorTab === 'tree';
    }

    handleInspectorTabActive(event) {
        const nextTab = event.detail?.value || event.target.value || 'details';
        this.clearTreeReadyTimeout();
        this.activeInspectorTab = nextTab;
        this.tabLoading = false;
        this.activeTreeRenderToken = ++this.treeRenderToken;
        this.treeLoading = false;
        this.treeRenderTimedOut = false;
        if (nextTab === 'tree') {
            const hasActions = (this.displayActions || []).length > 0;
            if (hasActions) {
                const renderToken = this.activeTreeRenderToken;
                this.tabLoading = true;
                this.treeLoading = true;
                // The timeout prevents a missing child ready event from leaving the tree spinner forever.
                // eslint-disable-next-line @lwc/lwc/no-async-operation
                this.treeReadyTimeoutId = setTimeout(() => {
                    if (this.activeInspectorTab === 'tree' && this.activeTreeRenderToken === renderToken) {
                        this.tabLoading = false;
                        this.treeLoading = false;
                        this.treeRenderTimedOut = true;
                        this.treeReadyTimeoutId = null;
                    }
                }, TREE_READY_TIMEOUT_MS);
            }
        }
    }

    clearTreeReadyTimeout() {
        if (this.treeReadyTimeoutId) {
            clearTimeout(this.treeReadyTimeoutId);
            this.treeReadyTimeoutId = null;
        }
    }

    handleTreeReady(event) {
        if (event.detail?.renderToken !== this.activeTreeRenderToken || this.activeInspectorTab !== 'tree') {
            return;
        }
        this.clearTreeReadyTimeout();
        this.tabLoading = false;
        this.treeLoading = false;
        this.treeRenderTimedOut = false;
    }

    get isInspectorBusy() {
        return this.detailLoading || this.tabLoading || this.treeLoading;
    }

    get queueEmptyTitle() {
        if (this.blockedLogCount > 0 && this.scanPendingCount === 0 && !this.transactions.length) {
            return 'Some recent logs could not be analyzed';
        }
        if (this.scanPendingCount > 0) {
            return 'Checking recent Apex debug logs';
        }
        if (this.queueStats.logCount === 0) {
            return 'No recent Apex debug logs found';
        }
        if (this.queueStats.businessCardCount > 0) {
            return 'No DML matches the selected filters';
        }
        if (this.queueStats.internalDmlCount > 0 && this.queueStats.confirmedDmlCount === this.queueStats.internalDmlCount) {
            return 'Only technical logging activity was found';
        }
        return 'No business-object DML found';
    }

    get queueEmptyMessage() {
        if (this.blockedLogCount > 0 && this.scanPendingCount === 0 && !this.transactions.length) {
            return `${this.blockedLogCount} recent log(s) could not be analyzed because indexing failed or the log exceeded the interactive size limit.`;
        }
        if (this.scanPendingCount > 0) {
            return `Checking ${this.scanPendingCount} recent log(s) for business-object DML. This may take a moment.`;
        }
        if (this.queueStats.logCount === 0) {
            return 'Run a transaction with debug logging enabled, then click Refresh to check again.';
        }
        if (this.queueStats.businessCardCount > 0) {
            return 'DML was found, but none matches the selected Object, Status, or DML Type filters.';
        }
        if (this.queueStats.internalDmlCount > 0 && this.queueStats.confirmedDmlCount === this.queueStats.internalDmlCount) {
            return 'Technical logger activity was excluded. No business-object DML was found in the scanned logs.';
        }
        return 'The scanned logs did not contain a business-object DML event. Check the trace flag and run the transaction again.';
    }

    get steps() {
        if (this.stepsCacheDetail === this.detail && this.stepsCacheSelectedId === this.selectedStepId) {
            return this.stepsCacheValue;
        }
        this.stepsCacheDetail = this.detail;
        this.stepsCacheSelectedId = this.selectedStepId;
        this.stepsCacheValue = (this.detail.steps || []).map((step) => {
            const normalized = {
                ...step,
                Duration_ms__c: this.toNumber(step.Duration_ms__c),
                SOQL_Queries_Used__c: this.toNumber(step.SOQL_Queries_Used__c),
                DML_Statements_Used__c: this.toNumber(step.DML_Statements_Used__c),
                CPU_Time_Used_ms__c: this.toNumber(step.CPU_Time_Used_ms__c),
                Heap_Size_Used_bytes__c: this.toNumber(step.Heap_Size_Used_bytes__c)
            };
            const changes = this.getChangesForStep(step.Id);
            return {
                ...normalized,
                durationLabel: this.formatDuration(normalized.Duration_ms__c),
                timelineClass: this.getStepClass(normalized),
                badgeClass: normalized.Status__c === 'Failed' ? 'slds-badge slds-theme_error' : 'slds-badge slds-theme_success',
                changes,
                changeCount: changes.length,
                hasChanges: changes.length > 0
            };
        });
        return this.stepsCacheValue;
    }

    get visibleSteps() {
        return this.steps;
    }

    get fieldChanges() {
        const changes = [];
        const grouped = this.detail.changesByStepId || {};
        Object.keys(grouped).forEach((key) => changes.push(...grouped[key]));
        return changes;
    }

    get fieldChangesGroups() {
        if (Array.isArray(this.detail.fieldChangesGroups) && this.detail.fieldChangesGroups.length > 0) {
            return this.detail.fieldChangesGroups;
        }
        const flat = this.fieldChanges || [];
        if (!flat.length) return [];
        return [{
            groupKey: 'default-group',
            objectName: this.selectedCardObject || 'Record',
            recordId: this.selectedRecordId || '(Captured Record)',
            recordUrl: this.selectedRecordUrl !== '#' ? this.selectedRecordUrl : null,
            isRealId: Boolean(this.selectedRecordId),
            fieldCount: flat.length,
            changes: flat
        }];
    }

    get hasFieldChanges() {
        return this.fieldChangesGroups.length > 0;
    }

    get fieldGroupPageCount() {
        return Math.max(1, Math.ceil(this.fieldChangesGroups.length / FIELD_GROUP_PAGE_SIZE));
    }

    get selectedFieldChangesGroup() {
        const groups = this.fieldChangesGroups;
        const start = (this.fieldGroupPage - 1) * FIELD_GROUP_PAGE_SIZE;
        const pageGroups = groups.slice(start, start + FIELD_GROUP_PAGE_SIZE);
        return pageGroups.find((group) => group.groupKey === this.selectedFieldGroupKey) || pageGroups[0];
    }

    get fieldGroupPageLabel() {
        return `Record ${Math.min(this.fieldGroupPage, this.fieldGroupPageCount)} of ${this.fieldGroupPageCount}`;
    }

    get isFirstFieldGroupPage() {
        return this.fieldGroupPage <= 1;
    }

    get isLastFieldGroupPage() {
        return this.fieldGroupPage >= this.fieldGroupPageCount;
    }

    previousFieldGroupPage() {
        if (this.fieldGroupPage > 1) {
            this.fieldGroupPage -= 1;
            this.selectedFieldGroupKey = this.fieldChangesGroups[(this.fieldGroupPage - 1) * FIELD_GROUP_PAGE_SIZE]?.groupKey;
        }
    }

    nextFieldGroupPage() {
        if (this.fieldGroupPage < this.fieldGroupPageCount) {
            this.fieldGroupPage += 1;
            this.selectedFieldGroupKey = this.fieldChangesGroups[(this.fieldGroupPage - 1) * FIELD_GROUP_PAGE_SIZE]?.groupKey;
        }
    }

    get fieldChangesEmptyMessage() {
        if (this.detail.fieldChangesAvailable === false) {
            return 'Field-level changes unavailable for this log level. Enable Variable logging (FINER/FINEST) to capture observed assignments.';
        }
        return 'No observed field changes captured for this transaction.';
    }

    get selectedCard() {
        if (this.selectedCardCacheTransactions === this.transactions &&
            this.selectedCardCacheDetail === this.detail &&
            this.selectedCardCacheId === this.selectedId) {
            return this.selectedCardCacheValue;
        }
        this.selectedCardCacheTransactions = this.transactions;
        this.selectedCardCacheDetail = this.detail;
        this.selectedCardCacheId = this.selectedId;
        this.selectedCardCacheValue = this.transactions.find((item) => item.Transaction_Id__c === this.selectedId) || this.detail?.log;
        return this.selectedCardCacheValue;
    }

    get selectedCardActions() {
        return this.selectedCard?.actions || [];
    }

    get selectedCardAncestorContext() {
        return this.selectedCard?.ancestorBreadcrumbs || [];
    }

    get selectedCardHasActions() {
        return (this.displayActions || []).length > 0;
    }

    @track isDebugOnly = false;
    @track expandState = null;

    handleCollapseAll() {
        this.expandState = 'NONE';
        // Reset the one-shot child command after it has rendered.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            this.expandState = null;
        }, 100);
    }

    handleDebugOnlyToggle(event) {
        this.isDebugOnly = event.target.checked;
    }

    get displayActions() {
        const rawActions = this.selectedCardActions || [];
        if (this.displayActionsCacheInput === rawActions && this.displayActionsCacheDebugOnly === this.isDebugOnly) {
            return this.displayActionsCacheValue;
        }
        this.displayActionsCacheInput = rawActions;
        this.displayActionsCacheDebugOnly = this.isDebugOnly;
        if (!this.isDebugOnly) {
            this.displayActionsCacheValue = rawActions;
            return this.displayActionsCacheValue;
        }
        this.displayActionsCacheValue = this.filterDebugOnly(rawActions);
        return this.displayActionsCacheValue;
    }

    filterDebugOnly(actionList) {
        if (!actionList || !actionList.length) return [];
        let visited = 0;
        const filter = (nodes) => {
            const result = [];
            for (const act of nodes || []) {
                if (visited >= MAX_DEBUG_ONLY_NODES) break;
                visited += 1;
                if (act.type === 'USER_DEBUG') {
                    result.push(act);
                } else if (act.children && act.children.length > 0) {
                    const filteredChildren = filter(act.children);
                    if (filteredChildren.length > 0) {
                        result.push({
                            ...act,
                            children: filteredChildren,
                            hasChildren: true
                        });
                    }
                }
            }
            return result;
        };
        return filter(actionList);
    }


    get isFailed() {
        return this.detail.log?.Status__c === 'Failed';
    }

    get isLogTruncated() {
        return Boolean(this.detail?.executionTree?.isTruncated || this.detail?.log?.isTruncated);
    }

    get detailStatusClass() {
        return this.isFailed ? 'slds-badge slds-theme_error' : 'slds-badge slds-theme_success';
    }

    get detailTimeLabel() {
        const rawTime = this.selectedCard?.timestampStr || this.selectedCard?.Start_Time__c || this.selectedCard?.StartTime || this.detail.log?.Start_Time__c || this.detail.log?.StartTime || this.detail.log?.startTime;
        return this.formatTimestamp(rawTime);
    }

    get selectedCardObject() {
        return this.selectedCard?.Object_API_Name__c || this.detail?.log?.Object_API_Name__c || 'Unknown';
    }

    get selectedCardOperation() {
        return this.selectedCard?.DML_Type__c || this.detail?.log?.DML_Type__c || 'DML';
    }

    get selectedCardOperationClass() {
        const op = (this.selectedCardOperation || '').toLowerCase();
        return `operation-pill op-${op}`;
    }

    get selectedCardRowCountLabel() {
        const count = this.selectedCard?.rowCount || this.detail?.log?.rowCount || 1;
        return `${count} Record${count > 1 ? 's' : ''}`;
    }

    get selectedRecordId() {
        const objName = this.selectedCardObject;
        const prefixes = { Account: '001', Contact: '003', Opportunity: '006', Lead: '00Q', Task: '00T', Case: '500', Asset: '02i', Campaign: '701', Contract: '800', Order: '801', User: '005' };
        const expectedPrefix = prefixes[objName];

        const cardRecId = this.selectedCard?.Record_Ids__c;
        if (cardRecId && expectedPrefix && cardRecId.startsWith(expectedPrefix)) {
            return cardRecId;
        }

        const scopedLog = this.selectedCard?.rawLog || this.detail?.log?.rawLog;
        const dmlScope = this.selectedCard?.dmlScope;
        if (scopedLog && dmlScope) {
            const scopedGroup = (this.detail?.fieldChangesGroups || []).find((group) => group.objectName === objName && group.isRealId);
            if (scopedGroup?.recordId) {
                return scopedGroup.recordId;
            }
        }

        return null;
    }

    get selectedRecordUrl() {
        if (!this.selectedRecordId) {
            return '#';
        }
        return `/lightning/r/${this.selectedCardObject}/${this.selectedRecordId}/view`;
    }

    get governorSoqlLabel() {
        const used = this.sumStepField('SOQL_Queries_Used__c');
        return `${used} / 100`;
    }

    get governorDmlLabel() {
        const used = this.sumStepField('DML_Statements_Used__c') || 1;
        return `${used} / 150`;
    }

    get governorCpuLabel() {
        const used = this.sumStepField('CPU_Time_Used_ms__c');
        return used > 0 ? `${used} / 10,000 ms` : 'Not captured';
    }

    get governorHeapLabel() {
        const used = this.maxStepField('Heap_Size_Used_bytes__c');
        return used > 0 ? `${(used / 1000000).toFixed(2)} / 6 MB` : 'Not captured';
    }

    get selectedCardUser() {
        return this.selectedCard?.Triggered_By__c || this.detail?.log?.Triggered_By__c || 'Current User';
    }

    get selectedCardStartTime() {
        const rawTime = this.selectedCard?.timestampStr || this.selectedCard?.Start_Time__c || this.selectedCard?.StartTime || this.detail?.log?.Start_Time__c || this.detail?.log?.StartTime || this.detail?.log?.startTime;
        return this.formatTimestamp(rawTime);
    }

    get selectedCardDuration() {
        return this.selectedCard?.durationLabel || this.detailDurationLabel || `${this.selectedCard?.durationMs || 0} ms`;
    }

    handleCopyRecordId() {
        if (!this.selectedRecordId) return;
        navigator.clipboard.writeText(this.selectedRecordId);
        this.showToast('Copied', `Record ID (${this.selectedRecordId}) copied to clipboard.`, 'success');
    }

    get executionHealthClass() {
        return this.hasHealthErrors ? 'important-events has-error' : 'important-events';
    }

    get failedHealthEvents() {
        return this.importantEvents.filter((eventItem) => eventItem.status === 'Failed');
    }

    get hasHealthErrors() {
        return this.failedHealthEvents.length > 0;
    }

    get importantEvents() {
        if (this.importantEventsCacheDetail === this.detail &&
            this.importantEventsCacheSelectedId === this.selectedId &&
            this.importantEventsCacheHealthKey === this.selectedHealthEventKey) {
            return this.importantEventsCacheValue;
        }
        const totalSoql = this.sumStepField('SOQL_Queries_Used__c');
        const errorText = this.detail.log?.Error_Message__c || '';
        const hasValidationError = /validation|FIELD_CUSTOM_VALIDATION_EXCEPTION|REQUIRED_FIELD_MISSING|required fields are missing/i.test(errorText);
        const hasSoqlLimitError = /too many soql queries/i.test(errorText);
        const hasCpuLimitError = /cpu time limit exceeded/i.test(errorText);
        const flowSteps = this.steps.filter((step) => step.Step_Type__c === 'Flow' || /^Flow:/i.test(step.Step_Name__c || ''));
        const failedFlowStep = flowSteps.find((step) => step.Status__c === 'Failed');
        const hasFlowError = Boolean(failedFlowStep) || /flow|FLOW_|CANNOT_EXECUTE_FLOW_TRIGGER|FLOW_ELEMENT_ERROR|process builder/i.test(errorText);
        const failedSteps = this.steps.filter((step) => step.Status__c === 'Failed');
        const firstFailedStep = failedSteps[0];
        const rootErrorText = firstFailedStep?.Error_Message__c || errorText;
        const isDebugLogCard = Boolean(this.detail.log?.IsDebugLog);
        const isTransactionFailed = this.isFailed || failedSteps.length > 0;

        const events = [];

        // 1. Root Error (Only if transaction FAILED)
        if (isTransactionFailed && rootErrorText) {
            events.push(
                this.buildEvent('rootError', 'Error', rootErrorText, 'Failed', {
                    longDetail: 'A failed event was captured for this transaction. Use this card first to identify the root error regardless of whether it came from Apex, Flow, validation, DML, or trigger logic.',
                    metrics: [
                        { label: 'Object', value: this.detail.log?.Object_API_Name__c || '-' },
                        { label: 'DML Type', value: this.detail.log?.DML_Type__c || '-' },
                        { label: 'Failed Step', value: firstFailedStep?.Step_Name__c || '-' },
                        { label: 'Step Type', value: firstFailedStep?.Step_Type__c || '-' },
                        { label: 'Transaction', value: this.detail.log?.Transaction_Id__c || '-' }
                    ],
                    actions: [
                        'Open the failed related step to inspect source, line number, and stack trace.',
                        'Fix the first failed event before checking later side effects.'
                    ],
                    relatedSteps: failedSteps,
                    errorMessage: rootErrorText
                })
            );
        }

        // 2. Validation Rule Error (Only if Validation Error occurred)
        if (hasValidationError) {
            events.push(
                this.buildEvent('validation', 'Validation', errorText, 'Failed', {
                    longDetail: 'A validation or required-field error was found in the transaction error message.',
                    metrics: [
                        { label: 'Validation Status', value: 'Failed' },
                        { label: 'Failed Steps', value: String(failedSteps.length) },
                        { label: 'Object', value: this.detail.log?.Object_API_Name__c || 'Unknown' }
                    ],
                    actions: [
                        'Open Object Manager and review required fields or validation rules for this object.',
                        'Check changed fields in this transaction against the validation condition.'
                    ],
                    relatedSteps: failedSteps,
                    errorMessage: errorText
                })
            );
        }

        const flowOverviewItems = [];
        const extractFlowItems = (nodes) => {
            (nodes || []).forEach((act) => {
                if (act.type === 'FLOW_START_INTERVIEW_BEGIN' || (act.type === 'CODE_UNIT_STARTED' && /^Flow:/i.test(act.name || '') && !act.children?.some(c => c.type === 'FLOW_START_INTERVIEW_BEGIN'))) {
                    const elements = (act.children || [])
                        .filter(c => c.type === 'FLOW_ELEMENT_BEGIN' || c.label === 'Flow Element')
                        .map(c => c.name);
                    const elementSummary = elements.length > 0 ? ` (Element: ${elements.join(', ')})` : '';
                    const durationText = act.durationLabel ? `${act.durationLabel}` : '';
                    flowOverviewItems.push({
                        id: `flow-item-${act.key || flowOverviewItems.length}`,
                        name: act.name || 'Flow',
                        info: `${durationText}${elementSummary}`.trim(),
                        icon: 'utility:flow'
                    });
                } else if (act.children && act.children.length > 0) {
                    extractFlowItems(act.children);
                }
            });
        };
        extractFlowItems(this.selectedCardActions);

        const soqlOverviewItems = [];
        const soslOverviewItems = [];
        const extractQueryItems = (nodes) => {
            (nodes || []).forEach((act) => {
                if (act.type === 'SOQL_EXECUTE_BEGIN') {
                    soqlOverviewItems.push({
                        id: `soql-item-${act.key || soqlOverviewItems.length}`,
                        name: act.name || 'SOQL Query',
                        info: act.durationLabel ? `${act.durationLabel}` : '',
                        icon: 'utility:search'
                    });
                } else if (act.type === 'SOSL_EXECUTE_BEGIN') {
                    soslOverviewItems.push({
                        id: `sosl-item-${act.key || soslOverviewItems.length}`,
                        name: act.name || 'SOSL Search',
                        info: act.durationLabel ? `${act.durationLabel}` : '',
                        icon: 'utility:preview'
                    });
                }
                if (act.children && act.children.length > 0) {
                    extractQueryItems(act.children);
                }
            });
        };
        extractQueryItems(this.selectedCardActions);

        const flowNamesList = Array.from(new Set(flowOverviewItems.map((item) => item.name))).filter(Boolean);
        const flowNamesSummary = flowNamesList.join(', ');
        const flowCardSubtitle = hasFlowError
            ? (failedFlowStep?.Error_Message__c || errorText || 'Flow error captured')
            : (flowOverviewItems.length > 0
                ? `${flowOverviewItems.length} Flow(s) executed: ${flowNamesSummary}`
                : `${flowSteps.length} Flow step(s) captured`);

        const soqlTargetsList = Array.from(new Set(soqlOverviewItems.map((item) => {
            const text = item.name || '';
            const match = text.match(/FROM\s+([A-Za-z0-9_]+)/i);
            return match ? match[1] : null;
        }))).filter(Boolean);
        const soqlTargetsSummary = soqlTargetsList.length > 0 ? ` (${soqlTargetsList.join(', ')})` : '';
        const soqlCardSubtitle = hasSoqlLimitError
            ? 'SOQL governor limit failure'
            : (soqlOverviewItems.length > 0
                ? `${soqlOverviewItems.length} SOQL Query(ies) executed${soqlTargetsSummary}`
                : `${totalSoql} queries used in captured steps`);

        const soslTargetsList = Array.from(new Set(soslOverviewItems.map((item) => {
            const text = item.name || '';
            const match = text.match(/RETURNING\s+([A-Za-z0-9_,\s()]+)/i);
            return match ? match[1].trim() : null;
        }))).filter(Boolean);
        const soslTargetsSummary = soslTargetsList.length > 0 ? ` (${soslTargetsList.join(', ')})` : '';
        const soslCardSubtitle = `${soslOverviewItems.length} SOSL Search(es) executed${soslTargetsSummary}`;

        // 3. Flow Events (Only if Flow failed or Flow steps actually ran)
        if (hasFlowError || flowSteps.length > 0 || flowOverviewItems.length > 0) {
            events.push(
                this.buildEvent(
                    'flow',
                    'Flow',
                    flowCardSubtitle,
                    hasFlowError ? 'Failed' : 'Success',
                    {
                        longDetail: hasFlowError
                            ? 'A Flow-related failure was detected from an explicit Flow log or Salesforce Flow exception text.'
                            : (isDebugLogCard ? 'Flow-related debug events were captured in the selected DML block.' : 'Flow logger step(s) were captured for this transaction.'),
                        metrics: [
                            { label: 'Flows Captured', value: String(flowOverviewItems.length || flowSteps.length) },
                            { label: 'Failed Flow Step', value: failedFlowStep?.Step_Name__c || '-' },
                            { label: 'Capture Mode', value: isDebugLogCard ? 'Debug Log Parse' : 'Explicit Flow Logger' }
                        ],
                        overviewItems: flowOverviewItems,
                        actions: hasFlowError
                            ? ['Open the failed Flow event and check element name or fault message.']
                            : ['For deeper Flow visibility, place TXNFlowLogger on important Flow elements.'],
                        relatedSteps: flowSteps,
                        errorMessage: hasFlowError ? (failedFlowStep?.Error_Message__c || errorText) : ''
                    }
                )
            );
        }

        // 4. Exceptions Event (Only if uncaught Apex Exception occurred)
        if (isTransactionFailed && !hasValidationError && !hasFlowError && !hasSoqlLimitError && !hasCpuLimitError) {
            events.push(
                this.buildEvent('exceptions', 'Exceptions', errorText || 'Apex Exception captured', 'Failed', {
                    longDetail: 'An exception was captured for this transaction. Failed steps are listed below.',
                    metrics: [
                        { label: 'Failed Steps', value: String(failedSteps.length) },
                        { label: 'Transaction Status', value: this.detail.log?.Status__c || '-' },
                        { label: 'Error Source', value: firstFailedStep?.Error_Class__c || '-' },
                        { label: 'Error Line', value: firstFailedStep?.Error_Line__c ? String(firstFailedStep.Error_Line__c) : '-' }
                    ],
                    actions: ['Open the failed step to inspect stack trace and line number.'],
                    relatedSteps: failedSteps,
                    errorMessage: errorText
                })
            );
        }

        // 5. SOQL Governor Metric (Show metrics if queries ran or limit breached)
        if (totalSoql > 0 || hasSoqlLimitError || soqlOverviewItems.length > 0) {
            events.push(
                this.buildEvent('soql', 'SOQL', soqlCardSubtitle, hasSoqlLimitError ? 'Failed' : 'Success', {
                    longDetail: hasSoqlLimitError
                        ? 'Salesforce reported a SOQL governor limit failure (over 100 queries).'
                        : (isDebugLogCard
                            ? 'SOQL usage is calculated from SOQL_EXECUTE_BEGIN events in the selected debug-log scope.'
                            : 'SOQL usage is calculated from recorded step usage.'),
                    metrics: [
                        { label: 'Total Queries', value: String(soqlOverviewItems.length || totalSoql) },
                        { label: 'Limit', value: '100 sync / 200 async' },
                        { label: 'Captured Steps', value: String(this.steps.length) }
                    ],
                    overviewItems: soqlOverviewItems,
                    actions: hasSoqlLimitError
                        ? ['Look for SOQL inside loops in the related trigger or handler.']
                        : ['If query count is high, compare related steps and move queries out of loops.'],
                    relatedSteps: this.steps.filter((step) => step.SOQL_Queries_Used__c > 0 || hasSoqlLimitError)
                })
            );
        }

        // 5b. SOSL Search Metric (Show separate card if SOSL search was executed)
        if (soslOverviewItems.length > 0) {
            events.push(
                this.buildEvent('sosl', 'SOSL', soslCardSubtitle, 'Success', {
                    longDetail: 'SOSL text search statements executed in this transaction.',
                    metrics: [
                        { label: 'SOSL Searches', value: String(soslOverviewItems.length) },
                        { label: 'Limit', value: '20 sync / 20 async' }
                    ],
                    overviewItems: soslOverviewItems
                })
            );
        }

        this.importantEventsCacheDetail = this.detail;
        this.importantEventsCacheSelectedId = this.selectedId;
        this.importantEventsCacheHealthKey = this.selectedHealthEventKey;
        this.importantEventsCacheValue = events.sort((left, right) => left.sortOrder - right.sortOrder);
        return this.importantEventsCacheValue;
    }

    async loadTransactions(options = {}) {
        const loadOptions = options?.target ? {} : options || {};
        const isManualRefresh = Boolean(options?.target || loadOptions.forceReload === true);
        const shouldPreserveSelection = loadOptions.preserveSelection === true;
        const shouldClearSelectionWhenHidden = loadOptions.clearSelectionWhenHidden === true;
        if (!isManualRefresh && queueSnapshot) {
            this.restoreQueueSnapshot();
            return;
        }
        if (isManualRefresh) {
            queueSnapshot = undefined;
            this.scanSessionId += 1;
            this.scanAbortController?.abort();
            this.scanAbortController = null;
            this.cancelActiveDetailParse();
            this.uploadedParseSession += 1;
            this.uploadedAbortController?.abort();
            this.uploadedAbortController = null;
            this.destroyUploadedWorker();
            this.transactions = [];
            this.queueVisibleCount = QUEUE_PAGE_SIZE;
            this.rawTransactionRows = [];
            this.debugLogBodies.clear();
            this.debugLogTrees.clear();
            this.debugLogCardResults.clear();
            this.detailCache.clear();
            this.parsedDebugEvents = [];
            this.blockedLogCount = 0;
            this.scanPendingCount = 0;
            this.queueStats = { logCount: 0, businessCardCount: 0, confirmedDmlCount: 0, internalDmlCount: 0 };
            this.uploadState = 'idle';
            this.uploadProgress = 0;
            this.uploadFileName = '';
            this.uploadMessage = '';
            this.uploadedFile = null;
            this.uploadedScopeCache.clear();
            this.clearFileInput();
            this.clearSelectedTransaction();
        }
        const sessionId = ++this.scanSessionId;
        this.scanAbortController?.abort();
        const scanAbortController = new AbortController();
        this.scanAbortController = scanAbortController;
        this.queueLoading = true;
        this.debugLogError = undefined;

        try {
            const queue = await this.withTimeout(
                getQueueLogs(),
                REMOTE_REQUEST_TIMEOUT_MS,
                'Loading recent Apex logs took too long. Please click Refresh and try again.'
            );
            const pendingLogs = queue?.pendingLogs || [];
            this.blockedLogCount = (queue?.blockedLogs || []).length;
            this.scanPendingCount = pendingLogs.length;
            if (!pendingLogs.length) {
                this.transactions = [];
                this.queueStats = { logCount: 0, businessCardCount: 0, confirmedDmlCount: 0, internalDmlCount: 0 };
                this.syncObjectOptions([]);
                this.saveQueueSnapshot();
                return;
            }

            const businessRows = [];
            this.queueStats = {
                logCount: pendingLogs.length,
                businessCardCount: businessRows.length,
                confirmedDmlCount: businessRows.length,
                internalDmlCount: 0,
                pendingCount: pendingLogs.length
            };
            const transactionRows = businessRows.filter((row) => row && this.matchesFilters(row));
            this.syncObjectOptions(businessRows);
            const selectedRow = transactionRows.find((row) => row.Transaction_Id__c === this.selectedId);
            this.rawTransactionRows = transactionRows;
            if (shouldPreserveSelection && selectedRow) {
                await this.loadQueueTransactionDetail(selectedRow, true);
            } else if (shouldClearSelectionWhenHidden && this.selectedId) {
                this.clearSelectedTransaction();
            }
            this.transactions = this.formatQueueRows(transactionRows);
            this.queueVisibleCount = QUEUE_PAGE_SIZE;
            this.saveQueueSnapshot();
            if (pendingLogs.length) {
                this.scanPendingLogs(pendingLogs, sessionId, scanAbortController.signal);
            }
        } catch (error) {
            this.transactions = [];
            this.queueStats = { logCount: 0, businessCardCount: 0, confirmedDmlCount: 0, internalDmlCount: 0 };
            this.syncObjectOptions([]);
            this.debugLogError = error?.body?.message || error?.message || 'We could not load recent Apex debug logs. Please click Refresh and try again.';
        } finally {
            if (sessionId === this.scanSessionId && this.scanPendingCount === 0) {
                this.queueLoading = false;
            }
        }
    }

    async scanPendingLogs(pendingLogs, sessionId, signal) {
        const work = [...pendingLogs];
        const worker = async () => {
            while (work.length && sessionId === this.scanSessionId && !signal?.aborted) {
                const log = work.shift();
                // Each worker intentionally processes one log at a time to cap memory and callouts.
                // eslint-disable-next-line no-await-in-loop
                await this.scanOneLog(log, sessionId, signal);
            }
        };
        try {
            await Promise.all([worker(), worker()]);
        } catch (error) {
            if (sessionId === this.scanSessionId && !signal?.aborted) {
                this.debugLogError = error?.message || 'Scanning stopped before all recent logs could be checked. Please click Refresh and try again.';
            }
        } finally {
            if (sessionId === this.scanSessionId && !signal?.aborted) {
                this.queueLoading = false;
            }
        }
    }

    async scanOneLog(log, sessionId, signal) {
        const logId = log?.Id;
        if (!logId || sessionId !== this.scanSessionId || signal?.aborted) return;
        try {
            if (Number(log.LogLength) > MAX_FETCHABLE_LOG_BYTES) {
                if (sessionId === this.scanSessionId) {
                    this.blockedLogCount += 1;
                    this.debugLogError = 'Some recent logs exceed the interactive parsing limit and were skipped.';
                }
                return;
            }

            const rawLog = await this.getDebugLogBody(logId);
            if (rawLog.length > MAX_FETCHABLE_LOG_BYTES) {
                this.debugLogBodies.delete(logId);
                throw new Error('This Apex debug log exceeds the interactive parsing limit and could not be analyzed.');
            }
            const tree = await buildExecutionTreeAsync(rawLog, { chunkSize: 1000, signal });
            this.setDebugLogTree(logId, tree);
            const parsedResult = await extractDmlCardResult(tree, { includeInferredUiSaves: false, signal });
            this.setDebugLogCardResult(logId, parsedResult);
            const summaries = (parsedResult.cards || []).map((card, index) => ({
                dmlIndex: index,
                objectName: card.Object_API_Name__c,
                operation: card.DML_Type__c,
                rows: card.rowCount || 1,
                isBusinessObject: card.isConfirmed !== false,
                status: card.Status__c,
                timestamp: card.timestampStr,
                startNanos: card.dmlScope?.startNanos,
                endNanos: card.dmlScope?.endNanos,
                startLine: card.dmlScope?.startLine,
                endLine: card.dmlScope?.endLine,
                isTruncated: Boolean(card.incomplete)
            }));
            if (sessionId === this.scanSessionId && !signal?.aborted && summaries.length) {
                const newRows = summaries.map((summary, index) => this.createDmlSummaryRow({
                    ...log,
                    DmlIndex: Number.isFinite(Number(summary.dmlIndex)) ? Number(summary.dmlIndex) : index,
                    DmlObjectName: summary.objectName,
                    DmlType: summary.operation,
                    DmlRows: summary.rows,
                    DmlStatus: summary.status,
                    DmlTimestamp: summary.timestamp,
                    DmlStartNanos: summary.startNanos,
                    DmlEndNanos: summary.endNanos,
                    DmlStartLine: summary.startLine,
                    DmlEndLine: summary.endLine,
                    DmlIsTruncated: summary.isTruncated
                }));
                this.addScannedRows(newRows, sessionId);
            }
        } catch (error) {
            if (error?.name === 'AbortError' || signal?.aborted) return;
            const message = error?.body?.message || error?.message || 'Unable to scan debug log.';
            if (sessionId === this.scanSessionId) {
                this.debugLogError = `This Apex debug log could not be analyzed. ${message}`;
                this.blockedLogCount += 1;
            }
        } finally {
            this.removePendingLog(logId, sessionId);
        }
    }

    addScannedRows(rows, sessionId) {
        if (sessionId !== this.scanSessionId || !rows.length) return;
        const existingIds = new Set((this.rawTransactionRows || []).map((row) => row.Transaction_Id__c));
        const merged = [...(this.rawTransactionRows || []), ...rows.filter((row) => !existingIds.has(row.Transaction_Id__c))];
        this.rawTransactionRows = merged;
        this.transactions = this.formatQueueRows(merged);
        this.queueStats = {
            ...this.queueStats,
            businessCardCount: merged.length,
            confirmedDmlCount: merged.length,
            pendingCount: this.scanPendingCount
        };
        this.syncObjectOptions(merged);
        this.saveQueueSnapshot();
    }

    removePendingLog(logId, sessionId) {
        if (sessionId !== this.scanSessionId) return;
        this.scanPendingCount = Math.max(0, this.scanPendingCount - 1);
        this.queueStats = { ...this.queueStats, pendingCount: this.scanPendingCount };
        this.saveQueueSnapshot();
    }

    saveQueueSnapshot() {
        const rows = (this.rawTransactionRows || []).filter((row) => !row.UploadedFile).map((row) => {
            const snapshotRow = { ...row };
            delete snapshotRow.rawLog;
            return snapshotRow;
        });
        queueSnapshot = {
            rows,
            filters: { ...this.filters },
            blockedLogCount: this.blockedLogCount,
            scanPendingCount: this.scanPendingCount,
            queueStats: {
                ...this.queueStats,
                businessCardCount: rows.length,
                confirmedDmlCount: rows.length
            }
        };
    }

    restoreQueueSnapshot() {
        if (!queueSnapshot) return;
        this.filters = { ...queueSnapshot.filters };
        this.rawTransactionRows = (queueSnapshot.rows || []).map((row) => ({ ...row }));
        this.blockedLogCount = queueSnapshot.blockedLogCount || 0;
        this.scanPendingCount = queueSnapshot.scanPendingCount || 0;
        this.queueStats = { ...queueSnapshot.queueStats };
        this.transactions = this.formatQueueRows(this.rawTransactionRows);
        this.syncObjectOptions(this.rawTransactionRows);
        this.endGlobalLoading(this.loadingToken);
        this.queueLoading = false;
        this.debugLogError = undefined;
    }

    createDmlSummaryRow(log) {
        const operation = log.DmlType || log.Operation || 'DML';
        const objectName = log.DmlObjectName || 'Object';
        const dmlIndex = Number.isFinite(Number(log.DmlIndex)) ? Number(log.DmlIndex) : 0;
        const displayIndex = dmlIndex + 1;
        const transactionId = `LOG-${log.Id}-DML-${displayIndex}`;
        const startValue = log.DmlStartNanos;
        const endValue = log.DmlEndNanos;
        const startNanos = startValue !== null && startValue !== undefined && Number.isFinite(Number(startValue))
            ? Number(startValue)
            : null;
        const endNanos = endValue !== null && endValue !== undefined && Number.isFinite(Number(endValue))
            ? Number(endValue)
            : null;
        const startByte = log.DmlStartByte !== null && log.DmlStartByte !== undefined && Number.isFinite(Number(log.DmlStartByte))
            ? Number(log.DmlStartByte)
            : null;
        const endByte = log.DmlEndByte !== null && log.DmlEndByte !== undefined && Number.isFinite(Number(log.DmlEndByte))
            ? Number(log.DmlEndByte)
            : null;
        const durationMs = Number.isFinite(startNanos) && Number.isFinite(endNanos)
            ? Number(((endNanos - startNanos) / 1000000).toFixed(2))
            : null;
        return {
            id: `dml-${log.Id}-${displayIndex}`,
            Id: `${log.Id}-DML-${displayIndex}`,
            DebugLogId: log.Id,
            Transaction_Id__c: transactionId,
            Object_API_Name__c: objectName,
            DML_Type__c: operation,
            Triggered_By__c: log.LogUserName,
            Status__c: (log.DmlStatus || log.Status) === 'Failed' ? 'Failed' : 'Success',
            rowCount: Number(log.DmlRows) || 1,
            timestampStr: log.DmlTimestamp || log.StartTime,
            durationMs,
            durationLabel: durationMs === null ? 'N/A' : `${durationMs} ms`,
            dmlScope: {
                startNanos,
                endNanos,
                startLine: Number.isFinite(Number(log.DmlStartLine)) ? Number(log.DmlStartLine) : null,
                endLine: Number.isFinite(Number(log.DmlEndLine)) ? Number(log.DmlEndLine) : null,
                objectName,
                operation,
                rowCount: Number(log.DmlRows) || 1,
                startByte,
                endByte,
                contextEvents: Array.isArray(log.DmlContextEvents) ? log.DmlContextEvents : []
            },
            actions: [],
            hasActions: false,
            isConfirmed: true,
            isInferred: false,
            IsDebugLog: true,
            isTruncated: Boolean(log.DmlIsTruncated)
        };
    }

    formatQueueRows(rows) {
        return (rows || []).filter((row) => row && this.matchesFilters(row)).map((row) => {
            const isSelected = row.Transaction_Id__c === this.selectedId || row.id === this.selectedId;
            const operation = row.DML_Type__c || row.operation || 'DML';
            const objectName = row.Object_API_Name__c || row.objectName || 'Object';
            const rawTime = row.timestampStr || row.Start_Time__c || row.StartTime || row.startTime || row.timestamp;
            const timeLabel = this.formatTimestamp(rawTime);
            return {
                ...row,
                cardTitle: row.cardTitle || `${objectName} ${operation}`,
                timeLabel,
                displayTime: timeLabel,
                operationBadgeClass: this.getOperationBadgeClass(operation),
                rowCountLabel: row.rowCount ? `${row.rowCount} row(s)` : (row.rowCountLabel || 'DML Event'),
                durationLabel: row.durationLabel || `${row.durationMs || 0} ms`,
                itemClass: isSelected ? 'queue-item selected' : 'queue-item',
                checked: false,
                badgeClass: row.Status__c === 'Failed' ? 'slds-badge slds-theme_error' : 'slds-badge slds-theme_success'
            };
        });
    }

    getOperationBadgeClass(op) {
        if (!op) return 'operation-pill';
        const lower = op.toLowerCase();
        if (lower === 'insert') return 'operation-pill op-insert';
        if (lower === 'update') return 'operation-pill op-update';
        if (lower === 'delete') return 'operation-pill op-delete';
        if (lower === 'upsert' || lower === 'merge') return 'operation-pill op-upsert';
        return 'operation-pill';
    }

    get parserFrameUrl() {
        return `${dmlLogParserFrameUrl}/index.html`;
    }

    handleUploadedParserFrameLoad(event) {
        this.uploadedParserFrame = event.target;
        this.uploadedParserFrameOrigin = new URL(event.target.src, window.location.href).origin;
    }

    handleUploadedParserFrameError() {
        this.uploadedParserFrameReady = false;
        this.rejectUploadedParserFrame(new Error('The local log parser could not be loaded. Please refresh the page and try again.'));
    }

    handleUploadedParserMessage(event) {
        const frame = this.uploadedParserFrame || this.template.querySelector('.parser-frame');
        if (!frame || event.source !== frame.contentWindow) return;
        this.uploadedParserFrame = frame;
        if (!this.uploadedParserFrameOrigin) {
            this.uploadedParserFrameOrigin = new URL(frame.src, window.location.href).origin;
        }
        if (event.origin !== this.uploadedParserFrameOrigin) return;
        const message = event.data || {};
        if (message.channel !== 'DML_LOG_PARSER_FRAME_V1') return;

        if (message.type === 'READY') {
            this.uploadedParserFrameReady = true;
            const resolvers = this.uploadedParserFrameResolvers.splice(0);
            resolvers.forEach((resolver) => resolver.resolve(this.uploadedParserFrame));
            return;
        }

        const pending = this.uploadedWorkerPending;
        if (!pending || pending.requestId !== message.requestId) return;

        if (message.type === 'PROGRESS') {
            if (message.phase === 'indexing' && this.uploadState === 'parsing') {
                this.uploadProgress = Math.min(85, Math.round(Number(message.progress || 0) * 85));
            }
            return;
        }
        if (message.type === 'RESULT') {
            pending.settleResolve(message.result);
        } else if (message.type === 'CANCELLED') {
            const error = new Error('Parsing cancelled.');
            error.name = 'AbortError';
            pending.settleReject(error);
        } else if (message.type === 'ERROR') {
            pending.settleReject(new Error(message.message || 'The local log parser failed while processing the file.'));
        }
    }

    waitForUploadedParserFrame(signal = null) {
        if (signal?.aborted) {
            const error = new Error('Parsing cancelled.');
            error.name = 'AbortError';
            return Promise.reject(error);
        }
        if (this.uploadedParserFrameReady && this.uploadedParserFrame) {
            return Promise.resolve(this.uploadedParserFrame);
        }

        return new Promise((resolve, reject) => {
            let timeoutId;
            let resolver;
            const abortHandler = () => {
                const index = this.uploadedParserFrameResolvers.indexOf(resolver);
                if (index !== -1) this.uploadedParserFrameResolvers.splice(index, 1);
                const error = new Error('Parsing cancelled.');
                error.name = 'AbortError';
                resolver.reject(error);
            };
            resolver = {
                resolve: (frame) => {
                    if (timeoutId) clearTimeout(timeoutId);
                    signal?.removeEventListener('abort', abortHandler);
                    resolve(frame);
                },
                reject: (error) => {
                    if (timeoutId) clearTimeout(timeoutId);
                    signal?.removeEventListener('abort', abortHandler);
                    reject(error);
                }
            };
            this.uploadedParserFrameResolvers.push(resolver);
            signal?.addEventListener('abort', abortHandler, { once: true });
            // The timeout is intentional: iframe readiness must not leave callers pending forever.
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            timeoutId = setTimeout(() => {
                const index = this.uploadedParserFrameResolvers.indexOf(resolver);
                if (index !== -1) this.uploadedParserFrameResolvers.splice(index, 1);
                resolver.reject(new Error('The local log parser did not start in time. Please refresh the page and try again.'));
            }, UPLOADED_PARSER_READY_TIMEOUT_MS);
        });
    }

    rejectUploadedParserFrame(error) {
        const resolvers = this.uploadedParserFrameResolvers.splice(0);
        resolvers.forEach((resolver) => resolver.reject(error));
        const pending = this.uploadedWorkerPending;
        if (pending) pending.settleReject(error);
    }

    runUploadedWorkerRequest(type, payload = {}, signal = null) {
        if (signal?.aborted) {
            const error = new Error('Parsing cancelled.');
            error.name = 'AbortError';
            return Promise.reject(error);
        }
        if (this.uploadedWorkerPending) {
            return Promise.reject(new Error('Another file is still being parsed. Please wait for it to finish or choose a new file.'));
        }
        const requestId = ++this.uploadedWorkerRequestId;
        return this.waitForUploadedParserFrame(signal).then((frame) => new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId;
            const sendCancel = () => {
                try {
                    frame.contentWindow.postMessage({
                        channel: 'DML_LOG_PARSER_FRAME_V1',
                        type: 'CANCEL',
                        requestId
                    }, this.uploadedParserFrameOrigin);
                } catch {
                    // The frame may already have been unloaded during refresh.
                }
            };
            let settleReject;
            const abortHandler = () => {
                sendCancel();
                const abortError = new Error('Parsing cancelled.');
                abortError.name = 'AbortError';
                settleReject(abortError);
            };
            const cleanup = () => {
                signal?.removeEventListener('abort', abortHandler);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };
            const settleResolve = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (this.uploadedWorkerPending?.requestId === requestId) this.uploadedWorkerPending = null;
                resolve(value);
            };
            settleReject = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (this.uploadedWorkerPending?.requestId === requestId) this.uploadedWorkerPending = null;
                reject(error);
            };
            this.uploadedWorkerPending = {
                requestId,
                settleResolve,
                settleReject,
                cleanup
            };
            signal?.addEventListener('abort', abortHandler, { once: true });
            // The timeout is intentional: isolated parsing must have a bounded lifetime.
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            timeoutId = setTimeout(() => {
                sendCancel();
                settleReject(new Error('Local log parsing took too long. Try a smaller file or a simpler debug log.'));
            }, UPLOADED_PARSER_REQUEST_TIMEOUT_MS);
            try {
                const messagePayload = type === 'PARSE_SCOPE'
                    ? { scope: payload.scope }
                    : payload;
                frame.contentWindow.postMessage({
                    channel: 'DML_LOG_PARSER_FRAME_V1',
                    type,
                    requestId,
                    ...messagePayload
                }, this.uploadedParserFrameOrigin);
            } catch (error) {
                settleReject(error);
            }
        }));
    }

    destroyUploadedWorker() {
        const pending = this.uploadedWorkerPending;
        this.uploadedWorkerPending = null;
        if (pending) {
            pending.cleanup();
            const error = new Error('Parsing cancelled.');
            error.name = 'AbortError';
            pending.settleReject(error);
        }
        if (this.uploadedParserFrame?.contentWindow && this.uploadedParserFrameReady) {
            try {
                this.uploadedParserFrame.contentWindow.postMessage({
                    channel: 'DML_LOG_PARSER_FRAME_V1',
                    type: 'RESET',
                    requestId: ++this.uploadedWorkerRequestId
                }, this.uploadedParserFrameOrigin);
            } catch {
                // The frame may already be unloading.
            }
        }
    }

    async handleFileUpload(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        const sessionId = ++this.uploadedParseSession;
        this.uploadedAbortController?.abort();
        this.destroyUploadedWorker();
        const uploadAbortController = new AbortController();
        this.uploadedAbortController = uploadAbortController;
        const signal = uploadAbortController.signal;
        this.uploadFileName = file.name;
        this.uploadProgress = 0;
        this.uploadMessage = '';
        this.uploadState = 'reading';
        this.uploadedFile = file;
        this.uploadedScopeCache.clear();
        const loadingToken = this.beginGlobalLoading();
        try {
            if (file.size > MAX_UPLOAD_BYTES) {
                throw new Error('This file is larger than the 60 MB interactive parsing limit.');
            }
            if (sessionId !== this.uploadedParseSession || signal.aborted) return;
            this.uploadState = 'parsing';
            const indexResult = await this.runUploadedWorkerRequest('INDEX_FILE', { file }, signal);
            if (sessionId !== this.uploadedParseSession || signal.aborted) return;
            const cards = indexResult?.cards || [];
            const uploadId = `UPLOAD-${Date.now()}`;
            const rows = cards.map((card, index) => this.createDmlSummaryRow({
                Id: uploadId,
                LogUserName: 'Local file',
                Status: card.status,
                StartTime: card.timestamp,
                DmlIndex: index,
                DmlObjectName: card.objectName,
                DmlType: card.operation,
                DmlRows: card.rows,
                DmlTimestamp: card.timestamp,
                DmlStartNanos: card.startNanos,
                DmlEndNanos: card.endNanos,
                DmlStartLine: card.startLine,
                DmlEndLine: card.endLine,
                DmlStartByte: card.startByte,
                DmlEndByte: card.endByte,
                DmlContextEvents: card.contextEvents,
                DmlIsTruncated: card.isTruncated
            }));
            rows.forEach((row) => {
                row.Transaction_Id__c = `${uploadId}-DML-${(row.dmlScope?.startLine ?? 0) + 1}-${row.DML_Type__c}`;
                row.UploadedFile = true;
                row.UploadId = uploadId;
            });
            const orgRows = (this.rawTransactionRows || []).filter((row) => !row.UploadedFile);
            this.rawTransactionRows = [...orgRows, ...rows];
            this.transactions = this.formatQueueRows(this.rawTransactionRows);
            this.syncObjectOptions(this.rawTransactionRows);
            this.queueStats = {
                ...this.queueStats,
                businessCardCount: this.rawTransactionRows.length,
                confirmedDmlCount: (this.queueStats.confirmedDmlCount || 0) + cards.length
            };
            this.uploadProgress = 100;
            this.uploadState = 'ready';
            this.uploadMessage = cards.length
                ? `File parsed successfully. ${cards.length} business DML card(s) were added to the queue.`
                : 'File parsed successfully, but no business-object DML was found. Make sure this is a Salesforce Apex debug log.';
            if (rows.length) {
                await this.loadQueueTransactionDetail(rows[0]);
            } else {
                this.clearSelectedTransaction();
            }
        } catch (error) {
            if (error?.name === 'AbortError' || sessionId !== this.uploadedParseSession) return;
            this.uploadState = 'error';
            this.uploadMessage = error?.message || 'We could not read this file as a Salesforce Apex debug log.';
            this.showToast('Unable to parse file', this.uploadMessage, 'error');
        } finally {
            this.endGlobalLoading(loadingToken);
            if (this.uploadedAbortController === uploadAbortController) {
                this.uploadedAbortController = null;
            }
            event.target.value = '';
        }
    }

    async handleSelect(event) {
        const transactionId = event.currentTarget.dataset.id;
        const row = (this.rawTransactionRows || this.transactions).find((item) => item.Transaction_Id__c === transactionId);
        if (!row) return;
        const isNewSelection = this.selectedId !== transactionId;
        this.cancelActiveDetailParse();
        this.clearTreeReadyTimeout();
        this.activeInspectorTab = 'details';
        this.activeTreeRenderToken = ++this.treeRenderToken;
        this.treeLoading = false;
        if (isNewSelection) {
            this.selectedStepId = null;
            this.selectedHealthEventKey = null;
            this.fieldGroupPage = 1;
            this.selectedFieldGroupKey = undefined;
            this.parsedDebugEvents = [];
            this.debugLogError = undefined;
            this.detail = this.detailCache.get(transactionId) || {};
            this.isDebugOnly = false;
        }
        const loadingToken = ++this.detailLoadingToken;
        this.detailLoading = !this.detailCache.has(row.Transaction_Id__c);
        try {
            await this.loadQueueTransactionDetail(row);
            this.transactions = this.formatQueueRows(this.rawTransactionRows || this.transactions);
        } catch (error) {
            if (error?.name === 'AbortError') return;
            const message = error?.body?.message || error?.message || 'We could not load this transaction\'s details. Please select it again.';
            this.debugLogError = message;
            this.showToast('Transaction details unavailable', message, 'error');
        } finally {
            if (loadingToken === this.detailLoadingToken) {
                this.detailLoading = false;
            }
        }
    }

    clearFileInput() {
        const fileInput = this.template?.querySelector('input[type="file"]');
        if (fileInput) fileInput.value = '';
    }

    handleFilterChange(event) {
        this.filters = { ...this.filters, [event.target.dataset.field]: event.detail.value };
        this.clearSelectedTransaction();
        this.applyQueueFilters();
    }

    applyQueueFilters() {
        this.transactions = this.formatQueueRows(this.rawTransactionRows || []);
        this.queueVisibleCount = QUEUE_PAGE_SIZE;
        this.syncObjectOptions(this.rawTransactionRows || []);
        this.saveQueueSnapshot();
    }

    handleStepSelect(event) {
        this.selectedStepId = event.currentTarget.dataset.id;
    }

    handleHealthEventToggle(event) {
        const eventKey = event.currentTarget.dataset.key;
        this.selectedHealthEventKey = this.selectedHealthEventKey === eventKey ? null : eventKey;
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    async loadQueueTransactionDetail(row, preserveStepSelection = false) {
        if (!row) {
            this.clearSelectedTransaction();
            return;
        }
        await this.loadDebugTransactionDetail(row, preserveStepSelection);
    }

    async getUploadedScopeResult(row, signal) {
        if (!this.uploadedFile) {
            throw new Error('The uploaded file is no longer available. Please choose the file again.');
        }
        const cacheKey = row.Transaction_Id__c;
        if (this.uploadedScopeCache.has(cacheKey)) {
            const cached = this.uploadedScopeCache.get(cacheKey);
            this.uploadedScopeCache.delete(cacheKey);
            this.uploadedScopeCache.set(cacheKey, cached);
            return cached;
        }

        const workerResult = await this.runUploadedWorkerRequest('PARSE_SCOPE', {
            file: this.uploadedFile,
            scope: row.dmlScope
        }, signal);
        if (workerResult?.tooLarge) {
            throw new Error(workerResult.message || 'This DML scope is too large to display interactively.');
        }
        const result = {
            rawLog: workerResult?.rawLog || '',
            executionTree: workerResult?.tree,
            treeResult: workerResult?.treeResult || { cards: [] },
            debugEvents: workerResult?.debugEvents || [],
            fieldChanges: workerResult?.fieldChanges || { groups: [], flat: [] },
            fieldChangesAvailable: Boolean(workerResult?.fieldChangesAvailable),
            dmlScope: {
                ...(workerResult?.scope || row.dmlScope),
                contextEvents: row.dmlScope?.contextEvents || []
            }
        };
        while (this.uploadedScopeCache.size >= MAX_UPLOADED_SCOPE_CACHE_ENTRIES) {
            this.uploadedScopeCache.delete(this.uploadedScopeCache.keys().next().value);
        }
        this.uploadedScopeCache.set(cacheKey, result);
        return result;
    }

    async loadDebugTransactionDetail(row, preserveStepSelection = false) {
        const requestToken = ++this.detailRequestToken;
        const abortController = new AbortController();
        this.detailAbortController = abortController;
        const signal = abortController.signal;
        this.selectedId = row.Transaction_Id__c;
        this.activeInspectorTab = 'details';
        this.clearTreeReadyTimeout();
        this.tabLoading = false;
        this.treeLoading = false;
        this.treeRenderTimedOut = false;
        this.selectedDebugLogId = row.DebugLogId;
        this.selectedHealthEventKey = null;
        const priorStepId = preserveStepSelection ? this.selectedStepId : null;
        const cachedDetail = this.detailCache.get(row.Transaction_Id__c);
        if (cachedDetail) {
            this.detail = cachedDetail;
            this.fieldGroupPage = 1;
            this.selectedFieldGroupKey = cachedDetail.fieldChangesGroups?.[0]?.groupKey;
            const cachedSteps = cachedDetail.steps || [];
            const cachedPriorStep = cachedSteps.find((step) => step.Id === priorStepId);
            const cachedFailedStep = cachedSteps.find((step) => step.Status__c === 'Failed');
            this.selectedStepId = cachedPriorStep?.Id || cachedFailedStep?.Id || cachedSteps[0]?.Id;
            if (this.detailAbortController === abortController) this.detailAbortController = null;
            return;
        }
        let rawLog;
        let executionTree;
        let treeResult;
        let detailScope = row.dmlScope;
        let uploadedScopeResult;
        if (row.UploadedFile) {
            uploadedScopeResult = await this.getUploadedScopeResult(row, signal);
            rawLog = uploadedScopeResult.rawLog;
            executionTree = uploadedScopeResult.executionTree;
            treeResult = uploadedScopeResult.treeResult;
            detailScope = uploadedScopeResult.dmlScope;
        } else {
            rawLog = row.rawLog || await this.getDebugLogBody(row.DebugLogId);
        }
        if (requestToken !== this.detailRequestToken || this.selectedId !== row.Transaction_Id__c) {
            return;
        }
        row.rawLog = rawLog || '';
        if (!row.UploadedFile && this.debugLogTrees.has(row.DebugLogId)) {
            executionTree = this.debugLogTrees.get(row.DebugLogId);
            this.debugLogTrees.delete(row.DebugLogId);
            this.debugLogTrees.set(row.DebugLogId, executionTree);
        } else if (!row.UploadedFile) {
            executionTree = await buildExecutionTreeAsync(rawLog || '', { chunkSize: 1000, signal });
            this.setDebugLogTree(row.DebugLogId, executionTree);
        }
        if (!row.UploadedFile && this.debugLogCardResults.has(row.DebugLogId)) {
            treeResult = this.debugLogCardResults.get(row.DebugLogId);
            this.debugLogCardResults.delete(row.DebugLogId);
            this.debugLogCardResults.set(row.DebugLogId, treeResult);
        } else if (!row.UploadedFile) {
            treeResult = await extractDmlCardResult(executionTree, { includeInferredUiSaves: false, signal });
            this.setDebugLogCardResult(row.DebugLogId, treeResult);
        }
        const matchingCard = (treeResult.cards || []).find((card) => {
            const sameScope = Number.isFinite(Number(row.dmlScope?.startNanos)) &&
                Number.isFinite(Number(card.dmlScope?.startNanos)) &&
                Number(row.dmlScope.startNanos) === Number(card.dmlScope.startNanos);
            const sameObject = card.Object_API_Name__c === row.Object_API_Name__c;
            const sameOperation = card.DML_Type__c === row.DML_Type__c;
            return sameScope || (sameObject && sameOperation);
        });
        if (matchingCard) {
            row.actions = matchingCard.actions || [];
            row.hasActions = row.actions.length > 0;
            row.ancestorBreadcrumbs = matchingCard.ancestorBreadcrumbs?.length
                ? matchingCard.ancestorBreadcrumbs
                : (row.dmlScope?.contextEvents || []);
            this.transactions = this.formatQueueRows(this.rawTransactionRows || []);
        }
        this.parsedDebugEvents = row.UploadedFile
            ? (uploadedScopeResult?.debugEvents || [])
            : await this.parseDebugLog(rawLog || '', detailScope, signal);
        const debugSteps = this.buildDebugSteps(this.parsedDebugEvents);
        const extractedResult = row.UploadedFile
            ? (uploadedScopeResult?.fieldChanges || { groups: [], flat: [] })
            : await extractFieldChangesFromDebugLog(rawLog || '', detailScope, { signal });
        const parsedDetail = {
            log: row,
            executionTree,
            steps: debugSteps,
            changesByStepId: { defaultStep: extractedResult.flat || [] },
            fieldChangesGroups: extractedResult.groups || [],
            fieldChangesAvailable: row.UploadedFile
                ? Boolean(uploadedScopeResult?.fieldChangesAvailable)
                : (rawLog || '').includes('|VARIABLE_ASSIGNMENT|')
        };
        this.fieldGroupPage = 1;
        this.selectedFieldGroupKey = parsedDetail.fieldChangesGroups[0]?.groupKey;
        this.setDetailCache(row.Transaction_Id__c, parsedDetail);
        this.detail = parsedDetail;
        const priorStep = debugSteps.find((step) => step.Id === priorStepId);
        const failedStep = debugSteps.find((step) => step.Status__c === 'Failed');
        this.selectedStepId = priorStep?.Id || failedStep?.Id || debugSteps[0]?.Id;
        if (this.detailAbortController === abortController) this.detailAbortController = null;
    }

    cancelActiveDetailParse() {
        if (this.detailAbortController) {
            this.detailAbortController.abort();
            this.detailAbortController = null;
        }
        this.detailRequestToken += 1;
    }

    setDetailCache(key, value) {
        if (this.detailCache.has(key)) {
            this.detailCache.delete(key);
        }
        while (this.detailCache.size >= MAX_DETAIL_CACHE_ENTRIES) {
            this.detailCache.delete(this.detailCache.keys().next().value);
        }
        this.detailCache.set(key, value);
    }

    setDebugLogTree(logId, tree) {
        if (!logId || !tree) return;
        if (this.debugLogTrees.has(logId)) this.debugLogTrees.delete(logId);
        while (this.debugLogTrees.size >= MAX_RAW_LOG_CACHE_ENTRIES) {
            this.debugLogTrees.delete(this.debugLogTrees.keys().next().value);
        }
        this.debugLogTrees.set(logId, tree);
    }

    setDebugLogCardResult(logId, result) {
        if (!logId || !result) return;
        if (this.debugLogCardResults.has(logId)) this.debugLogCardResults.delete(logId);
        while (this.debugLogCardResults.size >= MAX_RAW_LOG_CACHE_ENTRIES) {
            this.debugLogCardResults.delete(this.debugLogCardResults.keys().next().value);
        }
        this.debugLogCardResults.set(logId, result);
    }

    clearSelectedTransaction() {
        this.cancelActiveDetailParse();
        this.clearTreeReadyTimeout();
        this.detailLoadingToken += 1;
        this.selectedId = null;
        this.selectedDebugLogId = null;
        this.activeInspectorTab = 'details';
        this.detailLoading = false;
        this.tabLoading = false;
        this.treeLoading = false;
        this.treeRenderTimedOut = false;
        this.activeTreeRenderToken = ++this.treeRenderToken;
        this.selectedStepId = null;
        this.selectedHealthEventKey = null;
        this.fieldGroupPage = 1;
        this.selectedFieldGroupKey = undefined;
        this.parsedDebugEvents = [];
        this.detail = {};
    }

    formatDuration(value) {
        return `${this.toNumber(value)} ms`;
    }

    formatTimestamp(value) {
        if (!value) return '-';
        const strVal = String(value).trim();
        try {
            const dt = new Date(strVal.replace(' ', 'T'));
            if (!Number.isNaN(dt.getTime())) {
                return dt.toLocaleString([], {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });
            }
        } catch {
            // fall through to raw string
        }
        return strVal;
    }

    toNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    sumStepField(fieldName) {
        return (this.steps || []).reduce((total, step) => total + this.toNumber(step[fieldName]), 0);
    }

    maxStepField(fieldName) {
        return (this.steps || []).reduce((maximum, step) => Math.max(maximum, this.toNumber(step[fieldName])), 0);
    }

    buildEvent(key, label, detail, status, options = {}) {
        const isFailed = status === 'Failed';
        const isInfo = status === 'Info';
        const isExpanded = this.selectedHealthEventKey === key;
        const relatedSteps = (options.relatedSteps || []).map((step) => ({
            ...step,
            healthRowClass: step.Status__c === 'Failed' ? 'health-step-row failed' : 'health-step-row'
        }));
        const metrics = [...(options.metrics || [])];
        const overviewItems = options.overviewItems || [];
        const failedRelatedStep = relatedSteps.find((step) => step.Status__c === 'Failed');
        const eventErrorMessage = options.errorMessage || failedRelatedStep?.Error_Message__c || '';
        if (isFailed && failedRelatedStep?.Error_Class__c && !metrics.some((metric) => metric.label === 'Error Source')) {
            metrics.push({ label: 'Error Source', value: failedRelatedStep.Error_Class__c });
        }
        if (isFailed && failedRelatedStep?.Error_Line__c && !metrics.some((metric) => metric.label === 'Line Number')) {
            metrics.push({ label: 'Line Number', value: String(failedRelatedStep.Error_Line__c) });
        }
        return {
            key,
            label,
            isFailed,
            detail: detail || '-',
            longDetail: options.longDetail || detail || '-',
            metrics,
            overviewItems,
            hasOverviewItems: overviewItems.length > 0,
            actions: (options.actions || []).map((action, index) => ({ key: `${key}-${index}`, text: action })),
            hasActions: (options.actions || []).length > 0,
            relatedSteps,
            hasRelatedSteps: relatedSteps.length > 0,
            errorMessage: eventErrorMessage,
            expanded: isExpanded,
            cardClass: isFailed ? 'important-event-card failed' : 'important-event-card',
            status: isInfo ? 'Not Captured' : status,
            sortOrder: isFailed ? 0 : isInfo ? 2 : 1,
            rowClass: `${isFailed ? 'important-event failed' : isInfo ? 'important-event neutral' : 'important-event success'}${isExpanded ? ' selected' : ''}`,
            detailClass: isFailed ? 'health-detail-panel failed' : 'health-detail-panel',
            toggleIcon: isExpanded ? 'utility:chevrondown' : 'utility:chevronright',
            toggleText: isExpanded ? `Hide ${label} details` : `Show ${label} details`,
            badgeClass: isFailed ? 'slds-badge slds-theme_error' : isInfo ? 'slds-badge' : 'slds-badge slds-theme_success',
            iconName: isFailed ? 'utility:error' : isInfo ? 'utility:info' : 'utility:success',
            iconVariant: isFailed ? 'error' : isInfo ? 'bare' : 'success'
        };
    }

    getStepClass(step) {
        const stateClass = step.Status__c === 'Failed' ? 'failed' : 'success';
        const selectedClass = step.Id === this.selectedStepId ? ' selected' : '';
        return `execution-node ${stateClass}${selectedClass}`;
    }

    getChangesForStep(stepId) {
        const grouped = this.detail.changesByStepId || {};
        return grouped[stepId] || [];
    }

    syncObjectOptions(rows) {
        const objectNames = Array.from(new Set((rows || []).map((row) => row.Object_API_Name__c).filter((value) => value))).sort();
        this.objectOptions = [
            { label: 'All Objects', value: 'All' },
            ...objectNames.map((value) => ({ label: value, value }))
        ];
    }

    matchesFilters(row) {
        if (this.filters.objectName !== 'All' && row.Object_API_Name__c !== this.filters.objectName) {
            return false;
        }
        if (this.filters.status !== 'All' && row.Status__c !== this.filters.status) {
            return false;
        }
        if (this.filters.dmlType !== 'All' && row.DML_Type__c !== this.filters.dmlType) {
            return false;
        }
        return true;
    }

    async fetchDebugLogBody(logId) {
        try {
            return await this.withTimeout(
                fetchLogBody({ logId }),
                REMOTE_REQUEST_TIMEOUT_MS,
                'Loading the Apex debug log took too long. Please click Refresh and try again.'
            );
        } catch (error) {
            throw new Error(error?.body?.message || error?.message || 'We could not load the Apex debug log body. Please try again.');
        }
    }

    withTimeout(promise, timeoutMs, message) {
        let timeoutId;
        return new Promise((resolve, reject) => {
            // The timeout is intentional so remote Apex requests cannot keep the UI pending forever.
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
            Promise.resolve(promise).then((value) => {
                clearTimeout(timeoutId);
                resolve(value);
            }).catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
        });
    }

    async getDebugLogBody(logId) {
        if (this.debugLogBodies.has(logId)) {
            const cached = this.debugLogBodies.get(logId);
            this.debugLogBodies.delete(logId);
            this.debugLogBodies.set(logId, cached);
            return cached;
        }
        const rawLog = await this.fetchDebugLogBody(logId);
        while (this.debugLogBodies.size >= MAX_RAW_LOG_CACHE_ENTRIES) {
            this.debugLogBodies.delete(this.debugLogBodies.keys().next().value);
        }
        this.debugLogBodies.set(logId, rawLog || '');
        return rawLog || '';
    }

    buildDebugSteps(events) {
        return (events || []).map((eventItem, index) => ({
            Id: eventItem.key,
            Step_Key__c: eventItem.key,
            Step_Name__c: eventItem.title,
            Step_Type__c: eventItem.type,
            Sequence_Number__c: index + 1,
            Status__c: eventItem.severity === 'error' ? 'Failed' : 'Success',
            Error_Message__c: eventItem.severity === 'error' ? eventItem.detail : null,
            Error_Class__c: eventItem.type,
            Error_Line__c: null,
            Stack_Trace__c: null,
            Duration_ms__c: 0,
            Start_Time__c: null,
            End_Time__c: null,
            SOQL_Queries_Used__c: eventItem.type === 'SOQL' && /\bBEGIN\b/i.test(eventItem.title || '') ? 1 : 0,
            DML_Statements_Used__c: eventItem.type === 'DML' && /started/i.test(eventItem.title) ? 1 : 0,
            CPU_Time_Used_ms__c: 0,
            Heap_Size_Used_bytes__c: 0
        }));
    }

    async parseDebugLog(rawLog, dmlScope = null, signal = null) {
        const hasDmlScope = Number.isFinite(dmlScope?.startNanos);
        const contextLines = (dmlScope?.contextEvents || []).map((contextEvent) => ({
            line: `${contextEvent.timestampStr || '-'} (${contextEvent.startNanos || 0})|${contextEvent.type}|${contextEvent.detail || ''}`,
            isContext: true
        }));
        const logLines = getScopedLogLines(rawLog, dmlScope).map(({ rawLine, lineIndex }) => ({
            line: rawLine,
            lineIndex,
            isContext: false
        }));
        const events = [];
        let counter = 0;
        let lastValidationRuleName = null;
        const lines = [...contextLines, ...logLines];
        const chunkSize = 1000;

        for (let start = 0; start < lines.length; start += chunkSize) {
            if (signal?.aborted) {
                const error = new Error('Parsing cancelled.');
                error.name = 'AbortError';
                throw error;
            }
            const end = Math.min(start + chunkSize, lines.length);
            for (const { line, lineIndex, isContext } of lines.slice(start, end)) {
            if (signal?.aborted) {
                const error = new Error('Parsing cancelled.');
                error.name = 'AbortError';
                throw error;
            }
            const timestampNanos = this.extractDebugTimestampNanos(line);
            if (!isContext && Number.isFinite(dmlScope?.startLine) && lineIndex < dmlScope.startLine) {
                    continue;
            }
            if (!isContext && Number.isFinite(dmlScope?.endLine) && lineIndex > dmlScope.endLine) {
                continue;
            }
            if (!isContext && hasDmlScope && !this.isWithinDmlScope(timestampNanos, dmlScope)) {
                continue;
            }

            const parts = line.split('|');
            const marker = parts.length > 1 ? parts[1] : line;
            const details = parts.slice(2).join(' | ') || line;
            let eventConfig;
            if (line.includes('FATAL_ERROR') || line.includes('EXCEPTION_THROWN')) {
                eventConfig = { type: 'Error', severity: 'error', iconName: 'utility:error', title: this.cleanDebugMarker(marker), detail: this.cleanDebugDetail(details) };
            } else if (line.includes('FLOW_')) {
                eventConfig = { type: 'Flow', severity: /ERROR|FAULT/i.test(line) ? 'error' : 'info', iconName: 'utility:flow', title: this.cleanDebugMarker(marker), detail: this.extractFlowDetail(details) };
            } else if (line.includes('DML_BEGIN') || line.includes('DML_END')) {
                eventConfig = this.extractDmlEvent(marker, details, dmlScope);
            } else if (line.includes('SOQL_EXECUTE_') || line.includes('SOSL_EXECUTE_')) {
                eventConfig = { type: line.includes('SOSL_') ? 'SOSL' : 'SOQL', severity: 'info', iconName: 'utility:search', title: this.cleanDebugMarker(marker), detail: this.extractSoqlDetail(details) };
            } else if (line.includes('VALIDATION_') || /FIELD_CUSTOM_VALIDATION_EXCEPTION|REQUIRED_FIELD_MISSING/i.test(line)) {
                const validation = marker.startsWith('VALIDATION_')
                    ? this.parseValidationEventDetails(marker, details, lastValidationRuleName)
                    : null;
                if (validation?.ruleName) lastValidationRuleName = validation.ruleName;
                const validationTitle = validation?.ruleName
                    ? `Validation: ${validation.ruleName}`
                    : this.cleanDebugMarker(marker);
                const validationDetail = [
                    validation ? `Status: ${validation.status}` : null,
                    validation?.detail || (!validation ? this.cleanDebugDetail(details) : null)
                ].filter(Boolean).join(' | ');
                eventConfig = { type: 'Validation', severity: 'warning', iconName: 'utility:warning', title: validationTitle, detail: validationDetail || 'Validation rule detail unavailable' };
            } else if (line.includes('WF_')) {
                eventConfig = { type: 'Workflow', severity: 'info', iconName: 'utility:automation', title: this.cleanDebugMarker(marker), detail: this.cleanDebugDetail(details) };
            } else if (line.includes('METHOD_ENTRY') || line.includes('METHOD_EXIT')) {
                eventConfig = { type: 'Apex Method', severity: 'info', iconName: 'utility:apex', title: this.cleanDebugMarker(marker), detail: this.extractCodeUnitDetail(details) };
            } else if (line.includes('CODE_UNIT_STARTED') || line.includes('CODE_UNIT_FINISHED')) {
                eventConfig = { type: 'Code Unit', severity: 'info', iconName: 'utility:apex', title: this.cleanDebugMarker(marker), detail: this.extractCodeUnitDetail(details) };
            } else if (line.includes('LIMIT_USAGE_FOR_NS') || line.includes('CUMULATIVE_LIMIT_USAGE')) {
                eventConfig = { type: 'Limits', severity: 'info', iconName: 'utility:chart', title: this.cleanDebugMarker(marker), detail: this.cleanDebugDetail(details) };
            }
            if (!eventConfig) {
                    continue;
            }
            events.push({
                key: `debug-${counter++}`,
                ...eventConfig,
                detail: eventConfig.detail || this.cleanDebugDetail(details),
                isContext,
                timestampNanos,
                rowClass: eventConfig.severity === 'error' ? 'debug-event error' : eventConfig.severity === 'warning' ? 'debug-event warning' : 'debug-event',
                badgeClass: eventConfig.severity === 'error' ? 'slds-badge slds-theme_error' : eventConfig.severity === 'warning' ? 'slds-badge slds-theme_warning' : 'slds-badge'
            });
            }
            if (end < lines.length) {
                // Yield between debug-event batches to keep large-detail rendering responsive.
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => {
                    // eslint-disable-next-line @lwc/lwc/no-async-operation
                    setTimeout(resolve, 0);
                });
            }
        }
        return events;
    }

    isWithinDmlScope(timestampNanos, dmlScope) {
        if (!Number.isFinite(dmlScope?.startNanos)) {
            return true;
        }
        if (!Number.isFinite(timestampNanos)) {
            return false;
        }
        return timestampNanos >= dmlScope.startNanos &&
            (!Number.isFinite(dmlScope.endNanos) || timestampNanos <= dmlScope.endNanos);
    }

    extractDebugTimestampNanos(line) {
        const match = String(line || '').match(/\((\d+)\)/);
        return match ? Number(match[1]) : null;
    }

    extractDmlEvent(marker, details, dmlScope = null) {
        const isStart = marker === 'DML_BEGIN';
        const operation = this.extractDebugValue(details, 'Op') || dmlScope?.operation || 'DML';
        const objectApiName = this.extractDebugValue(details, 'Type') || dmlScope?.objectName || 'Unknown Object';
        const rows = this.extractDebugValue(details, 'Rows') || dmlScope?.rowCount;
        return {
            type: 'DML',
            severity: 'info',
            iconName: 'utility:database',
            title: `${operation} ${objectApiName} ${isStart ? 'started' : 'completed'}`,
            detail: rows ? `${rows} row(s) affected` : this.cleanDebugDetail(details)
        };
    }

    extractSoqlDetail(details) {
        const entities = this.extractDebugValue(details, 'Aggregations') || this.extractDebugValue(details, 'Rows');
        const query = details.match(/SELECT\s+.+/i)?.[0];
        if (query) {
            return query;
        }
        return entities ? `Rows: ${entities}` : this.cleanDebugDetail(details);
    }

    extractFlowDetail(details) {
        const flowName = details.match(/Interview Label:\s*([^|]+)/i)?.[1] || details.match(/Flow:\s*([^|]+)/i)?.[1];
        return flowName ? flowName.trim() : this.cleanDebugDetail(details);
    }

    extractCodeUnitDetail(details) {
        const triggerMatch = details.match(/__sfdc_trigger\/([^:|]+)/i);
        const apexMatch = details.match(/apex:\/\/([^:|]+)/i);
        if (triggerMatch) {
            return `Trigger: ${triggerMatch[1]}`;
        }
        if (apexMatch) {
            return `Apex: ${apexMatch[1]}`;
        }
        return this.cleanDebugDetail(details);
    }

    extractDebugValue(text, key) {
        return text.match(new RegExp(`${key}:([^|]+)`, 'i'))?.[1]?.trim();
    }

    cleanDebugMarker(marker) {
        return (marker || 'Debug Event').replace(/_/g, ' ');
    }

    cleanDebugDetail(details) {
        return (details || '').replace(/\s+/g, ' ').trim() || '-';
    }

    parseValidationEventDetails(type, detail, previousRuleName = null) {
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
}

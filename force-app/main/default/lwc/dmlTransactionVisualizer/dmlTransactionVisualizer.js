import { LightningElement, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import dmlLogParserFrameUrl from '@salesforce/resourceUrl/dmlLogParserFrame';
import getTransactionDetail from '@salesforce/apex/DMLTransactionVisualizerApex.getTransactionDetail';
import deleteTransactions from '@salesforce/apex/DMLTransactionVisualizerApex.deleteTransactions';
import getQueueLogs from '@salesforce/apex/DebugLogController.getQueueLogs';
import fetchLogBody from '@salesforce/apex/DebugLogController.fetchLogBody';

// Keep the client-side guard aligned with DebugLogController's synchronous callout limit.
const MAX_FETCHABLE_LOG_BYTES = 5000000;
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
    debugLogFailures = [];
    debugLogError = '';
    detailError = '';
    lastUiError = '';
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
    selectedQueueIds = [];
    isQueueDeleteMode = false;
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
    uploadedWorkerQueue = [];
    uploadedWorkerPumpRunning = false;
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

    errorCallback(error, stack) {
        // This is the LWC error boundary for unexpected render/proxy errors. Keep the
        // component recoverable and replace Salesforce's generic component dialog with
        // an actionable message in the queue area.
        this.scanSessionId += 1;
        this.scanAbortController?.abort();
        this.uploadedAbortController?.abort();
        this.clearTreeReadyTimeout();
        this.queueLoading = false;
        this.detailLoading = false;
        this.tabLoading = false;
        this.treeLoading = false;
        this.loading = false;
        this.debugLogError = 'The visualizer hit an unexpected UI error. Refresh the component and try again.';
        this.detailError = 'This view could not be rendered. Refresh the component and try again.';
        // Preserve a short diagnostic for browser-console debugging without exposing a
        // potentially sensitive stack trace in the UI.
        this.lastUiError = this.extractErrorMessage(error) || (stack ? 'Unexpected component error.' : 'Unknown component error.');
    }

    extractErrorMessage(error) {
        if (!error) return '';
        const body = error.body;
        const candidates = [
            typeof body === 'string' ? body : null,
            body?.message,
            Array.isArray(body) ? body.find((item) => item?.message)?.message : null,
            body?.pageErrors?.[0]?.message,
            body?.output?.errors?.[0]?.message,
            error.message,
            error.statusText
        ];
        const message = candidates.find((value) => typeof value === 'string' && value.trim());
        if (message) return message.trim();
        if (Array.isArray(error.errors)) {
            const first = error.errors.find((item) => item?.message);
            if (first?.message) return String(first.message).trim();
        }
        return '';
    }

    getUserFacingError(error, context = '', fallback = 'An unexpected error occurred.') {
        const raw = this.extractErrorMessage(error) || fallback;
        const lower = raw.toLowerCase();
        if (lower.includes('scope is too large')) {
            return 'This DML detail scope is larger than the 10 MB interactive detail limit. The log can be indexed, but this detail cannot be opened interactively.';
        }
        if (lower.includes('60 mb') || lower.includes('file is larger')) {
            return 'This file exceeds the 60 MB local parsing limit. Choose a smaller Apex debug log.';
        }
        if (lower.includes('log_too_large') || lower.includes('too large') || lower.includes('interactive parsing limit')) {
            return 'This Apex debug log is larger than the 5 MB interactive limit. Download it and use Open local Apex log for larger files.';
        }
        if (lower.includes('named credential') || lower.includes('dml_tooling') || lower.includes('tooling_auth') || lower.includes('callout') || lower.includes('unauthorized') || lower.includes('forbidden')) {
            return 'Salesforce could not access the Tooling API. Verify that DML_Tooling exists, its principal is authenticated, and the user has the required API/ApexLog permission.';
        }
        if (lower.includes('log_not_found') || lower.includes('not found for the current user') || lower.includes('404')) {
            return 'This Apex debug log is no longer available for the current user. It may have expired, been deleted, or belong to another org.';
        }
        if (lower.includes('file_empty')) {
            return 'This file is empty. Choose a Salesforce Apex debug log with content and try again.';
        }
        if (lower.includes('log_empty') || lower.includes('empty log') || lower.includes('empty file')) {
            return 'Salesforce returned an empty debug log body. The log may still be generating or may have expired; wait briefly and click Refresh.';
        }
        if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('took too long')) {
            return `${context || 'The operation'} timed out. Try again, or use a smaller/local log file.`;
        }
        if (lower.includes('parser') || lower.includes('worker') || lower.includes('iframe') || lower.includes('local log')) {
            return `${context || 'The local log parser'} could not complete. Refresh the page and try again; if it continues, choose a smaller valid Salesforce Apex log.`;
        }
        if (lower.includes('permission') || lower.includes('access')) {
            return `${context || 'Salesforce denied this operation.'} Verify the user permission set and object access, then try again.`;
        }
        const clean = raw.replace(/^(?:[A-Z_]+):\s*/i, '').trim();
        return context ? `${context} ${clean}` : clean;
    }

    get hasDebugLogFailures() {
        return this.debugLogFailures.length > 0;
    }

    updateDebugLogFailureMessage() {
        this.debugLogError = this.debugLogFailures.length
            ? `${this.debugLogFailures.length} recent debug log(s) could not be analyzed. See the affected log details below.`
            : undefined;
    }

    recordDebugLogFailure(log, error) {
        const logId = log?.Id || 'unknown-log';
        const detail = this.getUserFacingError(error, '', 'Unable to analyze this Apex debug log.');
        const entry = {
            key: logId,
            logId,
            label: log?.StartTime ? `Log ${logId} (${log.StartTime})` : `Log ${logId}`,
            message: detail
        };
        this.debugLogFailures = [
            ...this.debugLogFailures.filter((item) => item.logId !== logId),
            entry
        ];
        this.updateDebugLogFailureMessage();
    }

    clearDebugLogFailure(logId) {
        if (!logId || !this.debugLogFailures.some((item) => item.logId === logId)) return;
        this.debugLogFailures = this.debugLogFailures.filter((item) => item.logId !== logId);
        this.updateDebugLogFailureMessage();
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

    handleTreeError(event) {
        if (event.detail?.renderToken !== this.activeTreeRenderToken || this.activeInspectorTab !== 'tree') {
            return;
        }
        this.clearTreeReadyTimeout();
        this.tabLoading = false;
        this.treeLoading = false;
        this.treeRenderTimedOut = true;
        this.detailError = 'The execution tree could not be rendered for this transaction. Switch tabs or select the transaction again to retry.';
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

    get selectedQueueCount() {
        return this.selectedQueueIds.length;
    }

    get hasSelectedQueueItems() {
        return this.selectedQueueCount > 0;
    }

    get selectedDeleteLabel() {
        if (!this.isQueueDeleteMode) {
            return 'Select Delete';
        }
        return this.selectedQueueCount > 1 ? `Delete ${this.selectedQueueCount} selected` : 'Delete selected';
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

    get hasVisibleSteps() {
        return this.visibleSteps.length > 0;
    }

    get selectedStep() {
        if (!this.selectedStepId && this.steps.length) {
            return this.steps.find((step) => step.Status__c === 'Failed') || this.steps[0];
        }
        return this.steps.find((step) => step.Id === this.selectedStepId);
    }

    get executionSummary() {
        const failed = this.steps.filter((step) => step.Status__c === 'Failed').length;
        return `${this.steps.length} steps / ${failed} failed / ${this.sumStepField('CPU_Time_Used_ms__c')} ms CPU`;
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

    handleExpandAll() {
        this.expandState = 'ALL';
        // Reset the one-shot child command after it has rendered.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            this.expandState = null;
        }, 100);
    }

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
        let rootResult = [];
        const frames = [{ nodes: actionList, index: 0, result: [], parent: null, parentNode: null }];
        while (frames.length) {
            const frame = frames[frames.length - 1];
            if (frame.index >= frame.nodes.length || visited >= MAX_DEBUG_ONLY_NODES) {
                frames.pop();
                if (frame.parent) {
                    if (frame.result.length) {
                        frame.parent.result.push({
                            ...frame.parentNode,
                            children: frame.result,
                            hasChildren: true
                        });
                    }
                } else {
                    rootResult = frame.result;
                }
                continue;
            }

            const act = frame.nodes[frame.index++];
            if (!act) continue;
            visited += 1;
            if (act.type === 'USER_DEBUG') {
                frame.result.push(act);
            } else if (act.children?.length) {
                frames.push({ nodes: act.children, index: 0, result: [], parent: frame, parentNode: act });
            }
        }
        return rootResult;
    }

    get hasDebugLogs() {
        return this.debugLogs.length > 0;
    }

    get hasParsedDebugEvents() {
        return this.parsedDebugEvents.length > 0;
    }


    get isFailed() {
        return this.detail.log?.Status__c === 'Failed';
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

    async handleCopyRecordId() {
        if (!this.selectedRecordId) return;
        try {
            await navigator.clipboard.writeText(this.selectedRecordId);
            this.showToast('Copied', `Record ID (${this.selectedRecordId}) copied to clipboard.`, 'success');
        } catch {
            this.showToast('Copy failed', 'The record ID could not be copied. Select and copy it manually.', 'warning');
        }
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

    get healthErrorTitle() {
        const firstError = this.failedHealthEvents[0];
        return firstError ? `${firstError.label} failed` : '';
    }

    get healthErrorDetail() {
        const firstError = this.failedHealthEvents[0];
        if (!firstError) {
            return '';
        }
        const moreCount = this.failedHealthEvents.length - 1;
        return moreCount > 0 ? `${firstError.detail} + ${moreCount} more issue(s)` : firstError.detail;
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
            const pending = [...(nodes || [])].reverse();
            while (pending.length) {
                const act = pending.pop();
                if (!act) continue;
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
                    for (let index = act.children.length - 1; index >= 0; index -= 1) {
                        pending.push(act.children[index]);
                    }
                }
            }
        };
        extractFlowItems(this.selectedCardActions);

        const soqlOverviewItems = [];
        const soslOverviewItems = [];
        const extractQueryItems = (nodes) => {
            const pending = [...(nodes || [])].reverse();
            while (pending.length) {
                const act = pending.pop();
                if (!act) continue;
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
                    for (let index = act.children.length - 1; index >= 0; index -= 1) {
                        pending.push(act.children[index]);
                    }
                }
            }
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
            this.selectedQueueIds = [];
            this.isQueueDeleteMode = false;
            this.blockedLogCount = 0;
            this.debugLogFailures = [];
            this.scanPendingCount = 0;
            this.queueStats = { logCount: 0, businessCardCount: 0, confirmedDmlCount: 0, internalDmlCount: 0 };
            this.uploadState = 'idle';
            this.uploadProgress = 0;
            this.uploadFileName = '';
            this.uploadMessage = '';
            this.uploadedFile = null;
            this.uploadedScopeCache.clear();
            this.detailError = '';
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
            this.debugLogFailures = (queue?.blockedLogs || []).map((log) => ({
                key: log.Id,
                logId: log.Id,
                label: log.StartTime ? `Log ${log.Id} (${log.StartTime})` : `Log ${log.Id}`,
                message: this.getUserFacingError(
                    new Error(log.IndexStatus || 'This log was not available for analysis.'),
                    '',
                    'This log was not available for analysis.'
                )
            }));
            this.updateDebugLogFailureMessage();
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
            this.debugLogError = this.getUserFacingError(
                error,
                'We could not load recent Apex debug logs.',
                'Please click Refresh and try again.'
            );
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
                this.debugLogError = this.getUserFacingError(
                    error,
                    'Scanning stopped before all recent logs could be checked.',
                    'Please click Refresh and try again.'
                );
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
                    this.recordDebugLogFailure(log, new Error('LOG_TOO_LARGE'));
                }
                return;
            }

            const rawLog = await this.getDebugLogBody(logId);
            if (!rawLog.trim()) {
                throw new Error('LOG_EMPTY: Salesforce returned an empty debug log body.');
            }
            if (rawLog.length > MAX_FETCHABLE_LOG_BYTES) {
                this.debugLogBodies.delete(logId);
                throw new Error('This Apex debug log exceeds the interactive parsing limit and could not be analyzed.');
            }
            const workerResult = await this.runUploadedWorkerRequest('PARSE_TEXT', {
                rawLog,
                mode: 'SUMMARY'
            }, signal);
            if (workerResult?.tooLarge) {
                throw new Error(workerResult.message || 'This Salesforce debug log exceeds the interactive parsing limit.');
            }
            const parsedResult = workerResult?.treeResult || { cards: [] };
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
            if (sessionId === this.scanSessionId && !signal?.aborted) {
                this.clearDebugLogFailure(logId);
            }
        } catch (error) {
            if (error?.name === 'AbortError' || signal?.aborted) return;
            if (sessionId === this.scanSessionId) {
                this.recordDebugLogFailure(log, error);
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
            debugLogFailures: this.debugLogFailures.map((item) => ({ ...item })),
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
        this.debugLogFailures = (queueSnapshot.debugLogFailures || []).map((item) => ({ ...item }));
        this.scanPendingCount = queueSnapshot.scanPendingCount || 0;
        this.queueStats = { ...queueSnapshot.queueStats };
        this.transactions = this.formatQueueRows(this.rawTransactionRows);
        this.syncObjectOptions(this.rawTransactionRows);
        this.endGlobalLoading(this.loadingToken);
        this.queueLoading = false;
        this.updateDebugLogFailureMessage();
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
                checked: this.selectedQueueIds.includes(row.Transaction_Id__c),
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
        // A reloaded iframe gets a new worker/READY handshake. Do not reuse the
        // previous readiness flag or the first postMessage can be lost.
        this.uploadedParserFrameReady = false;
        this.uploadedParserFrameOrigin = new URL(event.target.src, window.location.href).origin;
    }

    handleUploadedParserFrameError() {
        this.uploadedParserFrameReady = false;
        this.rejectUploadedParserFrame(new Error('PARSER_FRAME_UNAVAILABLE: The local log parser could not be loaded. Refresh the page and try again.'));
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
            const error = new Error(message.message || 'The local log parser failed while processing the file.');
            error.code = message.code;
            error.phase = message.phase;
            pending.settleReject(error);
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
        const queued = this.uploadedWorkerQueue.splice(0);
        queued.forEach((request) => request.settleReject(error));
        const pending = this.uploadedWorkerPending;
        if (pending) pending.settleReject(error);
    }

    runUploadedWorkerRequest(type, payload = {}, signal = null) {
        if (signal?.aborted) {
            const error = new Error('Parsing cancelled.');
            error.name = 'AbortError';
            return Promise.reject(error);
        }
        const requestId = ++this.uploadedWorkerRequestId;
        return new Promise((resolve, reject) => {
            let settled = false;
            let started = false;
            let sendCancel = () => {};
            let request;
            const abortHandler = () => {
                if (started) sendCancel();
                const abortError = new Error('Parsing cancelled.');
                abortError.name = 'AbortError';
                request.settleReject(abortError);
            };
            const cleanup = () => {
                signal?.removeEventListener('abort', abortHandler);
            };
            const settleResolve = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (this.uploadedWorkerPending?.requestId === requestId) this.uploadedWorkerPending = null;
                resolve(value);
                this.pumpUploadedWorkerQueue();
            };
            const settleReject = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                const queuedIndex = this.uploadedWorkerQueue.indexOf(request);
                if (queuedIndex !== -1) this.uploadedWorkerQueue.splice(queuedIndex, 1);
                if (this.uploadedWorkerPending?.requestId === requestId) this.uploadedWorkerPending = null;
                reject(error);
                this.pumpUploadedWorkerQueue();
            };
            request = {
                requestId,
                type,
                payload,
                signal,
                abortHandler,
                get settled() { return settled; },
                get started() { return started; },
                set started(value) { started = value; },
                get sendCancel() { return sendCancel; },
                set sendCancel(value) { sendCancel = value; },
                settleResolve,
                settleReject,
                cleanup
            };
            signal?.addEventListener('abort', abortHandler, { once: true });
            this.uploadedWorkerQueue.push(request);
            this.uploadedWorkerQueue.sort((left, right) => {
                const leftPriority = left.type === 'PARSE_TEXT' && left.payload?.mode === 'SUMMARY' ? 0 : 1;
                const rightPriority = right.type === 'PARSE_TEXT' && right.payload?.mode === 'SUMMARY' ? 0 : 1;
                return rightPriority - leftPriority;
            });
            this.pumpUploadedWorkerQueue();
        });
    }

    async pumpUploadedWorkerQueue() {
        if (this.uploadedWorkerPumpRunning || this.uploadedWorkerPending) return;
        this.uploadedWorkerPumpRunning = true;
        try {
            while (!this.uploadedWorkerPending && this.uploadedWorkerQueue.length) {
                const request = this.uploadedWorkerQueue.shift();
                if (!request || request.settled) continue;
                this.uploadedWorkerPending = request;
                let frame;
                try {
                    // Requests are intentionally serialized because one Worker owns the
                    // uploaded file handle and should not parse two large payloads at once.
                    // eslint-disable-next-line no-await-in-loop
                    frame = await this.waitForUploadedParserFrame(request.signal);
                } catch (error) {
                    request.settleReject(error);
                    continue;
                }
                if (request.settled || request.signal?.aborted) {
                    request.settleReject(new Error('Parsing cancelled.'));
                    continue;
                }

                request.started = true;
                request.sendCancel = () => {
                    try {
                        frame.contentWindow.postMessage({
                            channel: 'DML_LOG_PARSER_FRAME_V1',
                            type: 'CANCEL',
                            requestId: request.requestId
                        }, this.uploadedParserFrameOrigin);
                    } catch {
                        // The frame may already have been unloaded during refresh.
                    }
                };
                // The timeout is intentional: isolated parsing must have a bounded lifetime.
                // eslint-disable-next-line @lwc/lwc/no-async-operation
                const timeoutId = setTimeout(() => {
                    request.sendCancel();
                    request.settleReject(new Error('Local log parsing took too long. Try a smaller file or a simpler debug log.'));
                }, UPLOADED_PARSER_REQUEST_TIMEOUT_MS);
                request.cleanup = () => {
                    request.signal?.removeEventListener('abort', request.abortHandler);
                    clearTimeout(timeoutId);
                };
                try {
                    const messagePayload = request.type === 'PARSE_SCOPE'
                        ? { scope: request.payload.scope }
                        : request.payload;
                    frame.contentWindow.postMessage({
                        channel: 'DML_LOG_PARSER_FRAME_V1',
                        type: request.type,
                        requestId: request.requestId,
                        ...messagePayload
                    }, this.uploadedParserFrameOrigin);
                } catch (error) {
                    request.settleReject(error);
                }
                break;
            }
        } finally {
            this.uploadedWorkerPumpRunning = false;
            if (!this.uploadedWorkerPending && this.uploadedWorkerQueue.length) {
                this.pumpUploadedWorkerQueue();
            }
        }
    }

    destroyUploadedWorker(options = {}) {
        const preserveOrgRequests = options.preserveOrgRequests === true;
        const isUploadRequest = (request) => request?.type === 'INDEX_FILE' || request?.type === 'PARSE_SCOPE';
        const queued = this.uploadedWorkerQueue.filter((request) => !preserveOrgRequests || isUploadRequest(request));
        this.uploadedWorkerQueue = this.uploadedWorkerQueue.filter((request) => preserveOrgRequests && !isUploadRequest(request));
        const cancelError = new Error('Parsing cancelled.');
        cancelError.name = 'AbortError';
        queued.forEach((request) => request.settleReject(cancelError));
        const pending = this.uploadedWorkerPending;
        const cancelPending = pending && (!preserveOrgRequests || isUploadRequest(pending));
        if (cancelPending) {
            this.uploadedWorkerPending = null;
            pending.cleanup();
            pending.sendCancel?.();
            pending.settleReject(cancelError);
        }
        if (!preserveOrgRequests && this.uploadedParserFrame?.contentWindow && this.uploadedParserFrameReady) {
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
        this.destroyUploadedWorker({ preserveOrgRequests: true });
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
            if (file.size === 0) {
                throw new Error('FILE_EMPTY: This file is empty. Choose a Salesforce Apex debug log with content.');
            }
            if (file.size > MAX_UPLOAD_BYTES) {
                throw new Error('This file is larger than the 60 MB interactive parsing limit.');
            }
            if (sessionId !== this.uploadedParseSession || signal.aborted) return;
            this.uploadState = 'parsing';
            const indexResult = await this.runUploadedWorkerRequest('INDEX_FILE', { file }, signal);
            if (sessionId !== this.uploadedParseSession || signal.aborted) return;
            if (!Number(indexResult?.lineCount) || !Number(indexResult?.recognizedEventCount)) {
                throw new Error('FILE_FORMAT: This file does not look like a Salesforce Apex debug log. Check that you selected the raw .log/.txt file, not a screenshot, HTML page, or exported error response.');
            }
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
                : indexResult?.internalDmlCount
                    ? 'The log was recognized, but it contains only technical/logger DML. No business-object DML was added.'
                    : indexResult?.isTruncated
                        ? 'The log was recognized but is truncated before a complete business-object DML block could be indexed.'
                        : 'The log was recognized, but no business-object DML event was found. Check the trace flags and log filters.';
            if (rows.length) {
                await this.loadQueueTransactionDetail(rows[0]);
            } else {
                this.clearSelectedTransaction();
            }
        } catch (error) {
            if (error?.name === 'AbortError' || sessionId !== this.uploadedParseSession) return;
            this.uploadState = 'error';
            this.uploadMessage = this.getUserFacingError(
                error,
                'We could not read this file as a Salesforce Apex debug log.',
                'Choose a valid .log or .txt file and try again.'
            );
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
        this.detailError = '';
        this.activeInspectorTab = 'details';
        this.activeTreeRenderToken = ++this.treeRenderToken;
        this.treeLoading = false;
        if (isNewSelection) {
            this.selectedStepId = null;
            this.selectedHealthEventKey = null;
            this.fieldGroupPage = 1;
            this.selectedFieldGroupKey = undefined;
            this.parsedDebugEvents = [];
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
            const message = this.getUserFacingError(
                error,
                'We could not load this transaction\'s details.',
                'Please select it again.'
            );
            this.detailError = message;
            this.showToast('Transaction details unavailable', message, 'error');
        } finally {
            if (loadingToken === this.detailLoadingToken) {
                this.detailLoading = false;
            }
            if (this.detailAbortController?.signal?.aborted || loadingToken === this.detailLoadingToken) {
                this.detailAbortController = null;
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

    handleQueueCheckbox(event) {
        event.stopPropagation();
        if (!this.isQueueDeleteMode) {
            return;
        }
        const transactionId = event.target.dataset.id;
        if (!transactionId) {
            return;
        }
        const selected = new Set(this.selectedQueueIds);
        if (event.target.checked) {
            selected.add(transactionId);
        } else {
            selected.delete(transactionId);
        }
        this.selectedQueueIds = Array.from(selected);
        this.transactions = this.transactions.map((row) => ({
            ...row,
            checked: this.selectedQueueIds.includes(row.Transaction_Id__c)
        }));
    }

    handleQueueAction(event) {
        const action = event.detail.value;
        if (action === 'deleteSelected') {
            if (!this.isQueueDeleteMode) {
                this.isQueueDeleteMode = true;
                return;
            }
            this.deleteSelectedTransactions();
        }
    }

    handleRowAction(event) {
        event.stopPropagation();
        if (event.detail.value === 'delete') {
            const transactionId = event.currentTarget.dataset.id;
            this.deleteTransactionIds([transactionId]);
        }
    }

    async deleteSelectedTransactions() {
        await this.deleteTransactionIds(this.selectedQueueIds);
    }

    async deleteTransactionIds(transactionIds) {
        const ids = (transactionIds || []).filter((value) => value);
        if (!ids.length) {
            this.showToast('No transactions selected', 'Select one or more transactions to delete.', 'warning');
            return;
        }
        const loadingToken = this.beginGlobalLoading();
        try {
            await deleteTransactions({ transactionIds: ids });
            if (ids.includes(this.selectedId)) {
                this.clearSelectedTransaction();
            }
            this.selectedQueueIds = [];
            this.isQueueDeleteMode = false;
            await this.loadTransactions({ forceReload: true });
            this.showToast('Deleted', `${ids.length} transaction(s) deleted from the queue.`, 'success');
        } catch (error) {
            this.showToast(
                'Delete failed',
                this.getUserFacingError(error, 'The selected transactions could not be deleted.', 'Verify permissions and try again.'),
                'error'
            );
        } finally {
            this.endGlobalLoading(loadingToken);
        }
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    async loadQueueTransactionDetail(row, preserveStepSelection = false) {
        if (!row) {
            this.clearSelectedTransaction();
            return;
        }
        if (row.IsDebugLog) {
            await this.loadDebugTransactionDetail(row, preserveStepSelection);
            return;
        }
        await this.loadTransactionDetail(row.Transaction_Id__c, preserveStepSelection);
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
        let workerDetailResult;
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
        if (!row.UploadedFile) {
            workerDetailResult = await this.runUploadedWorkerRequest('PARSE_TEXT', {
                rawLog,
                mode: 'DETAIL',
                scope: detailScope
            }, signal);
            if (workerDetailResult?.tooLarge) {
                throw new Error(workerDetailResult.message || 'This Salesforce debug log exceeds the interactive parsing limit.');
            }
            executionTree = workerDetailResult?.tree || { type: 'ROOT', children: [] };
            treeResult = workerDetailResult?.treeResult || { cards: [] };
            this.setDebugLogTree(row.DebugLogId, executionTree);
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
            : (workerDetailResult?.debugEvents || []);
        const debugSteps = this.buildDebugSteps(this.parsedDebugEvents);
        const extractedResult = row.UploadedFile
            ? (uploadedScopeResult?.fieldChanges || { groups: [], flat: [] })
            : (workerDetailResult?.fieldChanges || { groups: [], flat: [] });
        const parsedDetail = {
            log: row,
            executionTree,
            steps: debugSteps,
            changesByStepId: { defaultStep: extractedResult.flat || [] },
            fieldChangesGroups: extractedResult.groups || [],
            fieldChangesAvailable: row.UploadedFile
                ? Boolean(uploadedScopeResult?.fieldChangesAvailable)
                : Boolean(workerDetailResult?.fieldChangesAvailable)
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

    async loadTransactionDetail(transactionId, preserveStepSelection = false) {
        if (!transactionId) {
            this.clearSelectedTransaction();
            return;
        }
        const requestToken = ++this.detailRequestToken;
        this.selectedId = transactionId;
        this.selectedHealthEventKey = null;
        const priorStepId = preserveStepSelection ? this.selectedStepId : null;
        const detail = await this.withTimeout(
            getTransactionDetail({ transactionId }),
            REMOTE_REQUEST_TIMEOUT_MS,
            'Loading transaction details took too long. Please select the transaction again.'
        );
        if (requestToken !== this.detailRequestToken || this.selectedId !== transactionId) {
            return;
        }
        this.detail = detail;
        const loadedSteps = this.detail.steps || [];
        const priorStep = loadedSteps.find((step) => step.Id === priorStepId);
        const failedStep = loadedSteps.find((step) => step.Status__c === 'Failed');
        this.selectedStepId = priorStep?.Id || failedStep?.Id || loadedSteps[0]?.Id;
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
        this.detailError = '';
        this.detail = {};
    }

    formatDuration(value) {
        return `${this.toNumber(value)} ms`;
    }

    formatTime(value) {
        if (!value) return '';
        const strVal = String(value).trim();
        const match = strVal.match(/\b(\d{2}:\d{2}:\d{2})\b/);
        if (match) {
            return match[1];
        }
        try {
            const dt = new Date(strVal.replace(' ', 'T'));
            if (!isNaN(dt.getTime())) {
                return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            }
        } catch {
            // ignore
        }
        return strVal;
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

    formatBytes(value) {
        const bytes = this.toNumber(value);
        if (bytes >= 1000000) {
            return `${(bytes / 1000000).toFixed(1)} MB`;
        }
        if (bytes >= 1000) {
            return `${(bytes / 1000).toFixed(1)} KB`;
        }
        return `${bytes} B`;
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

    analyzeLogSummary(log, rawLog) {
        const lines = rawLog.split(/\r?\n/);
        const dmlLine = lines.find((line) => line.includes('DML_BEGIN'));
        if (!dmlLine) {
            return null;
        }
        const parts = dmlLine.split('|');
        const details = parts.slice(2).join(' | ') || dmlLine;
        const dmlType = this.normalizeDmlValue(this.extractDebugValue(details, 'Op'));
        const objectApiName = this.extractDebugValue(details, 'Type');
        if (!objectApiName) {
            return null;
        }
        const errorLine = lines.find((line) => (
            line.includes('EXCEPTION_THROWN') ||
            line.includes('FATAL_ERROR') ||
            line.includes('FIELD_CUSTOM_VALIDATION_EXCEPTION') ||
            line.includes('REQUIRED_FIELD_MISSING')
        ));
        const importantCount = lines.filter((line) => this.isImportantDebugLine(line)).length;
        return {
            Id: log.Id,
            DebugLogId: log.Id,
            Transaction_Id__c: `LOG-${log.Id}`,
            Object_API_Name__c: objectApiName,
            DML_Type__c: dmlType || 'Unknown',
            Triggered_By__c: log.LogUserName,
            Triggered_By_Id__c: null,
            Status__c: log.Status === 'Success' && !errorLine ? 'Success' : 'Failed',
            Total_Steps__c: importantCount,
            Total_Duration_ms__c: 0,
            Start_Time__c: log.StartTime,
            End_Time__c: log.StartTime,
            Record_Ids__c: null,
            Error_Message__c: errorLine ? this.cleanDebugDetail(errorLine).slice(0, 255) : null,
            IsDebugLog: true
        };
    }

    isImportantDebugLine(line) {
        return line.includes('DML_BEGIN') ||
            line.includes('DML_END') ||
            line.includes('SOQL_EXECUTE_BEGIN') ||
            line.includes('SOSL_EXECUTE_BEGIN') ||
            line.includes('FLOW_START_INTERVIEW') ||
            line.includes('FLOW_ELEMENT_ERROR') ||
            line.includes('CODE_UNIT_STARTED') ||
            line.includes('LIMIT_USAGE_FOR_NS') ||
            line.includes('CUMULATIVE_LIMIT_USAGE') ||
            line.includes('EXCEPTION_THROWN') ||
            line.includes('FATAL_ERROR') ||
            line.includes('FIELD_CUSTOM_VALIDATION_EXCEPTION') ||
            line.includes('REQUIRED_FIELD_MISSING');
    }

    normalizeDmlValue(value) {
        if (!value) {
            return null;
        }
        const normalized = value.toLowerCase();
        if (normalized === 'insert') {
            return 'Insert';
        }
        if (normalized === 'update') {
            return 'Update';
        }
        if (normalized === 'delete') {
            return 'Delete';
        }
        if (normalized === 'undelete') {
            return 'Undelete';
        }
        return value;
    }

    async fetchDebugLogBody(logId) {
        try {
            return await this.withTimeout(
                fetchLogBody({ logId }),
                REMOTE_REQUEST_TIMEOUT_MS,
                'Loading the Apex debug log took too long. Please click Refresh and try again.'
            );
        } catch (error) {
            throw new Error(this.getUserFacingError(
                error,
                'We could not load the Apex debug log body.',
                'Please try again.'
            ));
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

    normalizeDebugTransaction(row) {
        return {
            ...row,
            Transaction_Id__c: row.transactionId,
            Object_API_Name__c: row.objectApiName,
            DML_Type__c: row.dmlType,
            Triggered_By__c: row.triggeredBy,
            Triggered_By_Id__c: row.triggeredById,
            Status__c: row.status,
            Total_Steps__c: row.totalSteps,
            Total_Duration_ms__c: row.totalDurationMs,
            Start_Time__c: row.startTime,
            End_Time__c: row.endTime,
            Record_Ids__c: row.recordIds,
            Error_Message__c: row.errorMessage,
            IsDebugLog: true
        };
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

    extractDebugValue(text, key) {
        return String(text || '').match(new RegExp(`${key}:([^|]+)`, 'i'))?.[1]?.trim();
    }

    cleanDebugDetail(details) {
        return (details || '').replace(/\s+/g, ' ').trim() || '-';
    }

}

import { LightningElement, api, track } from 'lwc';

const MAX_VISIBLE_NODES = 1000;

export default class DmlActionTree extends LightningElement {
    @api actions = [];
    @api ancestorContext = [];
    @api renderToken;
    @track expandedKeys = new Set();
    _expandState = null;
    _visibleLimitReached = false;
    _readySignature = null;
    _readyActions = null;
    _processedCacheActions = null;
    _processedCacheExpandedKeys = null;
    _processedCache = [];

    renderedCallback() {
        const signature = this.renderToken ?? 'default';
        if (this._readySignature === signature && this._readyActions === this.actions) return;
        if (this._readyActions && this._readyActions !== this.actions) {
            this.expandedKeys = new Set();
        }
        this._readySignature = signature;
        this._readyActions = this.actions;
        this.dispatchEvent(new CustomEvent('treeready', {
            bubbles: true,
            composed: true,
            detail: { renderToken: this.renderToken }
        }));
    }

    @api
    get expandState() {
        return this._expandState;
    }
    set expandState(value) {
        this._expandState = value;
        if (value === 'ALL') {
            this.expandAll();
        } else if (value === 'NONE') {
            this.collapseAll();
        }
    }

    get hasActions() {
        return Array.isArray(this.actions) && this.actions.length > 0;
    }

    get hasAncestorContext() {
        return Array.isArray(this.ancestorContext) && this.ancestorContext.length > 0;
    }

    @api expandAll() {
        const keys = new Set();
        this.collectAllKeys(this.actions, keys);
        this.expandedKeys = keys;
    }

    @api collapseAll() {
        const keys = new Set();
        this.collectAllCollapsedKeys(this.actions, keys);
        this.expandedKeys = keys;
    }

    collectAllKeys(actionList, setRef) {
        (actionList || []).forEach((act) => {
            if (act.hasChildren) {
                setRef.add(act.key);
                setRef.delete(`collapsed-${act.key}`);
                if (act.children && act.children.length > 0) {
                    this.collectAllKeys(act.children, setRef);
                }
            }
        });
    }

    collectAllCollapsedKeys(actionList, setRef) {
        (actionList || []).forEach((act) => {
            if (act.hasChildren) {
                setRef.delete(act.key);
                setRef.add(`collapsed-${act.key}`);
                if (act.children && act.children.length > 0) {
                    this.collectAllCollapsedKeys(act.children, setRef);
                }
            }
        });
    }

    get processedActions() {
        if (this._processedCacheActions === this.actions && this._processedCacheExpandedKeys === this.expandedKeys) {
            return this._processedCache;
        }
        const rows = [];
        this._visibleLimitReached = false;
        this.appendVisibleRows(this.actions || [], rows, 0);
        const maxDuration = Math.max(1, ...rows.map((row) => Number(row.durationMs) || 0));
        this._processedCache = rows.map((row) => {
            const duration = Number(row.durationMs) || 0;
            const percentage = duration > 0 ? Math.max(5, Math.round((duration / maxDuration) * 100)) : 0;
            return {
                ...row,
                displayType: this.friendlyType(row.type),
                durationStyle: `width: ${percentage}%;`,
                durationTone: duration >= 500 ? 'duration-tag duration-slow' : duration >= 100 ? 'duration-tag duration-warning' : 'duration-tag',
                itemClass: `${row.itemClass}${row.depth > 0 ? ' nested-node' : ''}${this.isErrorType(row.type) ? ' error-node' : ''}`
            };
        });
        this._processedCacheActions = this.actions;
        this._processedCacheExpandedKeys = this.expandedKeys;
        return this._processedCache;
    }

    get hasVisibleLimit() {
        // Force the visible projection to be calculated before reading the flag.
        const processedActions = this.processedActions;
        return Boolean(processedActions) && this._visibleLimitReached;
    }

    appendVisibleRows(actionList, rows, depth) {
        for (const action of actionList || []) {
            if (rows.length >= MAX_VISIBLE_NODES) {
                this._visibleLimitReached = true;
                return;
            }

            const isExpanded = this.expandedKeys.has(action.key) ||
                (!this.expandedKeys.has(`collapsed-${action.key}`) && action.defaultExpanded);
            rows.push({
                ...action,
                depth,
                indentStyle: `--tree-indent: ${Math.min(depth, 12) * 1.25}rem`,
                expanded: isExpanded,
                toggleIcon: isExpanded ? 'utility:chevrondown' : 'utility:chevronright',
                itemClass: action.incomplete ? 'tree-node incomplete-node' : 'tree-node'
            });

            if (isExpanded && action.children?.length) {
                this.appendVisibleRows(action.children, rows, depth + 1);
            }
            if (this._visibleLimitReached) return;
        }
    }

    handleToggle(event) {
        event.stopPropagation();
        const key = event.currentTarget.dataset.key;
        if (!key) return;

        const action = this.findAction(this.actions, key);
        const currentlyExpanded = this.expandedKeys.has(key) ||
            (!this.expandedKeys.has(`collapsed-${key}`) && action?.defaultExpanded);

        const newExpanded = new Set(this.expandedKeys);
        if (currentlyExpanded) {
            newExpanded.delete(key);
            newExpanded.add(`collapsed-${key}`);
        } else {
            newExpanded.add(key);
            newExpanded.delete(`collapsed-${key}`);
        }
        this.expandedKeys = newExpanded;
    }

    findAction(actionList, key) {
        for (const action of actionList || []) {
            if (action.key === key) return action;
            const nested = this.findAction(action.children, key);
            if (nested) return nested;
        }
        return null;
    }

    friendlyType(type) {
        const labels = {
            CODE_UNIT_STARTED: 'Apex Code',
            SOQL_EXECUTE_BEGIN: 'SOQL Query',
            SOSL_EXECUTE_BEGIN: 'SOSL Query',
            FLOW_START_INTERVIEW_BEGIN: 'Flow Started',
            FLOW_ELEMENT_BEGIN: 'Flow Element',
            DML_BEGIN: 'Database Operation',
            USER_DEBUG: 'Debug Message',
            VALIDATION_RULE: 'Validation',
            VALIDATION_PASS: 'Validation Passed',
            VALIDATION_FAIL: 'Validation Failed',
            WF_FIELD_UPDATE: 'Workflow Update',
            WF_RULE_EVAL_BEGIN: 'Workflow Rule',
            WF_CRITERIA_BEGIN: 'Workflow Criteria',
            WF_RULE_FILTER: 'Workflow Filter',
            WF_FLOW_ACTION_BEGIN: 'Workflow Action',
            EXCEPTION_THROWN: 'Exception',
            FATAL_ERROR: 'Fatal Error',
            FLOW_ELEMENT_ERROR: 'Flow Error'
        };
        if (labels[type]) return labels[type];
        return String(type || 'Event')
            .toLowerCase()
            .split('_')
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    isErrorType(type) {
        return /ERROR|EXCEPTION|FATAL|VALIDATION_FAIL/i.test(type || '');
    }
}

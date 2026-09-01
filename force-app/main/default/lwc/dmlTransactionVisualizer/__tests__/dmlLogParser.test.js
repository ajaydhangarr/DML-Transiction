import {
    buildExecutionTree,
    createExecutionTreeStreamState,
    consumeExecutionTreeStream,
    finishExecutionTreeStream,
    extractDmlCardResult,
    extractDmlCards,
    isInternalLoggingObject
} from '../dmlLogParser';

function dmlLine(time, operation, objectName, rows = 1) {
    return `${time}|DML_BEGIN|[1]|Op:${operation}|Type:${objectName}|Rows:${rows}`;
}

describe('dmlLogParser', () => {
    it('parses a log split across arbitrary file chunks without losing the partial line', async () => {
        const rawLog = [
            dmlLine('10:00:00.001 (1000000)', 'Insert', 'Account'),
            '10:00:00.002 (2000000)|DML_END|[1]'
        ].join('\n');
        const state = createExecutionTreeStreamState();
        consumeExecutionTreeStream(state, rawLog.slice(0, 17));
        consumeExecutionTreeStream(state, rawLog.slice(17), true);
        const result = await extractDmlCardResult(finishExecutionTreeStream(state), { includeInferredUiSaves: false });

        expect(result.cards).toHaveLength(1);
        expect(result.cards[0].Object_API_Name__c).toBe('Account');
    });

    it('creates confirmed cards for explicit business-object DML without object-specific rules', async () => {
        const rawLog = [
            dmlLine('10:00:00.001 (1000000)', 'Insert', 'Account'),
            '10:00:00.002 (2000000)|DML_END|[1]',
            dmlLine('10:00:00.003 (3000000)', 'Insert', 'Lead'),
            '10:00:00.004 (4000000)|DML_END|[1]',
            dmlLine('10:00:00.005 (5000000)', 'Update', 'Contact', 2),
            '10:00:00.006 (6000000)|DML_END|[1]',
            dmlLine('10:00:00.007 (7000000)', 'Delete', 'Opportunity'),
            '10:00:00.008 (8000000)|DML_END|[1]',
            dmlLine('10:00:00.009 (9000000)', 'Upsert', 'Project__c', 3),
            '10:00:00.010 (10000000)|DML_END|[1]'
        ].join('\n');

        const cards = await extractDmlCards(buildExecutionTree(rawLog));

        expect(cards).toHaveLength(5);
        expect(cards.map((card) => [card.Object_API_Name__c, card.DML_Type__c, card.rowCount])).toEqual([
            ['Account', 'Insert', 1],
            ['Lead', 'Insert', 1],
            ['Contact', 'Update', 2],
            ['Opportunity', 'Delete', 1],
            ['Project__c', 'Upsert', 3]
        ]);
        expect(cards.every((card) => card.isConfirmed && card.sourceEvent === 'DML_BEGIN')).toBe(true);
    });

    it('excludes internal logger transport/storage DML without excluding similarly named business objects', async () => {
        const rawLog = [
            dmlLine('10:00:00.001 (1000000)', 'Insert', 'TXN_Log_Event__e'),
            '10:00:00.002 (2000000)|DML_END|[1]',
            dmlLine('10:00:00.003 (3000000)', 'Insert', 'TXN_Step_Log_Event__e'),
            '10:00:00.004 (4000000)|DML_END|[1]',
            dmlLine('10:00:00.005 (5000000)', 'Insert', 'TXN_Field_Change_Event__e'),
            '10:00:00.006 (6000000)|DML_END|[1]',
            dmlLine('10:00:00.007 (7000000)', 'Insert', 'TXN_Log_Event__c'),
            '10:00:00.008 (8000000)|DML_END|[1]',
            dmlLine('10:00:00.009 (9000000)', 'Insert', 'Lead'),
            '10:00:00.010 (10000000)|DML_END|[1]',
            dmlLine('10:00:00.011 (11000000)', 'Insert', 'TXN_Log__c'),
            '10:00:00.012 (12000000)|DML_END|[1]',
            dmlLine('10:00:00.013 (13000000)', 'Insert', 'TXN_Step__c'),
            '10:00:00.014 (14000000)|DML_END|[1]',
            dmlLine('10:00:00.015 (15000000)', 'Insert', 'TXN_Field_Change__c'),
            '10:00:00.016 (16000000)|DML_END|[1]',
            dmlLine('10:00:00.017 (17000000)', 'Insert', 'Log_Index__c'),
            '10:00:00.018 (18000000)|DML_END|[1]'
        ].join('\n');

        const result = await extractDmlCardResult(buildExecutionTree(rawLog));

        expect(result.confirmedDmlCount).toBe(9);
        expect(result.internalDmlCount).toBe(7);
        expect(result.cards.map((card) => card.Object_API_Name__c)).toEqual(['TXN_Log_Event__c', 'Lead']);
        expect(isInternalLoggingObject('TXN_Log_Event__e')).toBe(true);
        expect(isInternalLoggingObject('TXN_Log_Event__c')).toBe(false);
    });

    it('creates an inferred trigger card when a UI save log has no explicit DML_BEGIN event', async () => {
        const rawLog = [
            '10:00:00.001 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|LeadTrigger on Lead trigger event BeforeInsert',
            '10:00:00.002 (2000000)|CODE_UNIT_FINISHED|LeadTrigger on Lead trigger event BeforeInsert'
        ].join('\n');

        const result = await extractDmlCardResult(buildExecutionTree(rawLog));

        expect(result.cards).toHaveLength(1);
        expect(result.cards[0].Object_API_Name__c).toBe('Lead');
        expect(result.cards[0].isInferred).toBe(true);
        expect(result.confirmedDmlCount).toBe(0);
        expect(result.internalDmlCount).toBe(0);
    });

    it('adds adjacent workflow, flow, and SLA roots to an inferred trigger card', async () => {
        const rawLog = [
            '10:00:00.001 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|CaseTrigger on Case trigger event AfterInsert',
            '10:00:00.002 (2000000)|SOQL_EXECUTE_BEGIN|[4]|Aggregations:0|SELECT Id FROM Account',
            '10:00:00.003 (3000000)|SOQL_EXECUTE_END|[4]|Rows:1',
            '10:00:00.004 (4000000)|CODE_UNIT_FINISHED|CaseTrigger on Case trigger event AfterInsert',
            '10:00:00.005 (5000000)|CODE_UNIT_STARTED|[EXTERNAL]|Workflow:Case',
            '10:00:00.006 (6000000)|WF_RULE_EVAL_BEGIN|Assignment',
            '10:00:00.007 (7000000)|WF_RULE_EVAL_END',
            '10:00:00.008 (8000000)|CODE_UNIT_FINISHED|Workflow:Case',
            '10:00:00.009 (9000000)|CODE_UNIT_STARTED|[EXTERNAL]|Flow:Case',
            '10:00:00.010 (10000000)|CODE_UNIT_FINISHED|Flow:Case',
            '10:00:00.011 (11000000)|CODE_UNIT_STARTED|[EXTERNAL]|SLA',
            '10:00:00.012 (12000000)|CODE_UNIT_FINISHED|SLA'
        ].join('\n');

        const [card] = await extractDmlCards(buildExecutionTree(rawLog));
        const automation = card.actions.find((action) => action.type === 'POST_SAVE_AUTOMATION');

        expect(automation).toBeDefined();
        expect(automation.children.map((action) => action.label)).toEqual([
            'Workflow',
            'Record-Triggered Flow',
            'SLA Automation'
        ]);
    });

    it('marks DML as failed and displays a Flow Error action', async () => {
        const rawLog = [
            dmlLine('10:00:00.001 (1000000)', 'Update', 'Case'),
            '10:00:00.002 (2000000)|FLOW_ELEMENT_ERROR|[1]|Flow failed at Update_Case',
            '10:00:00.003 (3000000)|DML_END|[1]'
        ].join('\n');

        const [card] = await extractDmlCards(buildExecutionTree(rawLog));
        const flowError = card.actions.find((action) => action.type === 'FLOW_ELEMENT_ERROR');

        expect(card.Status__c).toBe('Failed');
        expect(card.Error_Message__c).toContain('Flow failed at Update_Case');
        expect(flowError).toMatchObject({
            label: 'Flow Error',
            iconName: 'utility:error'
        });
    });

    it('retains successful validation and workflow events inside the DML tree', async () => {
        const rawLog = [
            dmlLine('10:00:00.001 (1000000)', 'Insert', 'Lead'),
            '10:00:00.002 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|LeadTrigger on Lead trigger event BeforeInsert',
            '10:00:00.003 (3000000)|VALIDATION_RULE|[12]|Lead: Validate_Company|Formula evaluated',
            '10:00:00.004 (4000000)|VALIDATION_PASS|[12]|Lead: Validate_Company|Validation passed',
            '10:00:00.005 (5000000)|CODE_UNIT_FINISHED|LeadTrigger on Lead trigger event BeforeInsert',
            '10:00:00.006 (6000000)|CODE_UNIT_STARTED|[EXTERNAL]|Workflow:Lead',
            '10:00:00.007 (7000000)|WF_RULE_EVAL_BEGIN|LeadWorkflowRule',
            '10:00:00.008 (8000000)|WF_CRITERIA_BEGIN|LeadWorkflowRule criteria',
            '10:00:00.009 (9000000)|WF_RULE_FILTER|LeadWorkflowRule criteria passed',
            '10:00:00.010 (10000000)|WF_CRITERIA_END',
            '10:00:00.011 (11000000)|WF_FLOW_ACTION_BEGIN|LeadWorkflowRule action',
            '10:00:00.012 (12000000)|WF_FLOW_ACTION_END',
            '10:00:00.013 (13000000)|WF_RULE_EVAL_END',
            '10:00:00.014 (14000000)|CODE_UNIT_FINISHED|Workflow:Lead',
            '10:00:00.015 (15000000)|DML_END|[1]'
        ].join('\n');

        const [card] = await extractDmlCards(buildExecutionTree(rawLog));
        const types = [];
        const collectTypes = (actions) => {
            (actions || []).forEach((action) => {
                types.push(action.type);
                collectTypes(action.children);
            });
        };
        collectTypes(card.actions);

        expect(types).toEqual(expect.arrayContaining([
            'VALIDATION_RULE',
            'VALIDATION_PASS',
            'WF_RULE_EVAL_BEGIN',
            'WF_CRITERIA_BEGIN',
            'WF_RULE_FILTER',
            'WF_FLOW_ACTION_BEGIN'
        ]));
        const validationNodes = [];
        const collectValidationNodes = (actions) => {
            (actions || []).forEach((action) => {
                if (action.type.startsWith('VALIDATION_')) validationNodes.push(action);
                collectValidationNodes(action.children);
            });
        };
        collectValidationNodes(card.actions);
        expect(validationNodes.map((action) => action.name)).toEqual([
            'Validate_Company — Formula evaluated',
            'Validate_Company — Validation passed'
        ]);
    });

    it('shows System.debug messages under their active DML scope', async () => {
        const rawLog = [
            dmlLine('10:00:00.001 (1000000)', 'Update', 'Case'),
            '10:00:00.002 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|CaseTrigger on Case trigger event BeforeUpdate',
            '10:00:00.003 (3000000)|USER_DEBUG|[42]|DEBUG|Before updating Case owner',
            '10:00:00.004 (4000000)|CODE_UNIT_FINISHED|CaseTrigger on Case trigger event BeforeUpdate',
            '10:00:00.005 (5000000)|DML_END|[1]'
        ].join('\n');

        const [card] = await extractDmlCards(buildExecutionTree(rawLog));
        const trigger = card.actions.find((action) => action.type === 'CODE_UNIT_STARTED');
        const debugMessage = trigger.children.find((action) => action.type === 'USER_DEBUG');

        expect(debugMessage).toMatchObject({
            label: 'Debug Message',
            iconName: 'utility:info',
            name: '[42]|DEBUG|Before updating Case owner'
        });
    });

    it('keeps each DML card scoped to its own nested actions and trigger context', async () => {
        const rawLog = [
            '10:00:00.001 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event BeforeInsert',
            dmlLine('10:00:00.002 (2000000)', 'Insert', 'Account'),
            '10:00:00.003 (3000000)|SOQL_EXECUTE_BEGIN|[4]|Aggregations:0|SELECT Id FROM Account',
            '10:00:00.004 (4000000)|SOQL_EXECUTE_END|[4]|Rows:1',
            '10:00:00.005 (5000000)|DML_END|[1]',
            dmlLine('10:00:00.006 (6000000)', 'Update', 'Contact'),
            '10:00:00.007 (7000000)|EXCEPTION_THROWN|[8]|System.DmlException: Contact failed',
            '10:00:00.008 (8000000)|DML_END|[1]',
            '10:00:00.009 (9000000)|CODE_UNIT_FINISHED|AccountTrigger on Account trigger event BeforeInsert'
        ].join('\n');

        const cards = await extractDmlCards(buildExecutionTree(rawLog));
        const [accountCard, contactCard] = cards;

        expect(accountCard.Status__c).toBe('Success');
        expect(accountCard.actions.map((action) => action.type)).toContain('SOQL_EXECUTE_BEGIN');
        expect(accountCard.actions.some((action) => /Contact failed/.test(action.name))).toBe(false);
        expect(accountCard.dmlScope.contextEvents.map((eventItem) => eventItem.type)).toContain('CODE_UNIT_STARTED');
        expect(contactCard.Status__c).toBe('Failed');
        expect(contactCard.actions.some((action) => action.type === 'EXCEPTION_THROWN')).toBe(true);
        expect(contactCard.dmlScope.startNanos).toBe(6000000);
        expect(contactCard.dmlScope.endNanos).toBe(8000000);
    });

    it('prunes empty container nodes while retaining duplicate container nodes that contain actions', () => {
        const rawLog = [
            '10:00:00.001 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|Flow:Lead',
            '10:00:00.002 (2000000)|FLOW_ELEMENT_BEGIN|[1]|demotest',
            '10:00:00.003 (3000000)|FLOW_ELEMENT_END|[1]',
            '10:00:00.004 (4000000)|CODE_UNIT_FINISHED|Flow:Lead',
            '10:00:00.005 (5000000)|CODE_UNIT_STARTED|[EXTERNAL]|__sfdc_trigger/LeadDemoTrigger',
            '10:00:00.006 (6000000)|CODE_UNIT_FINISHED|__sfdc_trigger/LeadDemoTrigger',
            '10:00:00.007 (7000000)|CODE_UNIT_STARTED|[EXTERNAL]|Validation:Lead:new',
            '10:00:00.008 (8000000)|CODE_UNIT_FINISHED|Validation:Lead:new',
            '10:00:00.009 (9000000)|CODE_UNIT_STARTED|[EXTERNAL]|__sfdc_trigger/LeadDemoTrigger',
            '10:00:00.010 (10000000)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Lead',
            '10:00:00.011 (11000000)|SOQL_EXECUTE_END|[1]|Rows:1',
            '10:00:00.012 (12000000)|CODE_UNIT_FINISHED|__sfdc_trigger/LeadDemoTrigger',
            '10:00:00.013 (13000000)|CODE_UNIT_STARTED|[EXTERNAL]|Flow:Lead',
            '10:00:00.014 (14000000)|CODE_UNIT_FINISHED|Flow:Lead'
        ].join('\n');

        const tree = buildExecutionTree(rawLog);

        expect(tree.children).toHaveLength(2);
        expect(tree.children[0].type).toBe('CODE_UNIT_STARTED');
        expect(tree.children[0].detail).toContain('Flow:Lead');
        expect(tree.children[1].type).toBe('CODE_UNIT_STARTED');
        expect(tree.children[1].detail).toContain('LeadDemoTrigger');
    });

});

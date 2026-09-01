/**
 * @description Test runner helper class for DML Transaction Visualizer demo.
 * Generates sample DML transactions on Lead and Task objects.
 */
public with sharing class LeadDemoService {

    /**
     * @description Executes a complete successful Lead transaction.
     * Triggers: LeadDemoTrigger -> SOQL -> SOSL -> Task DML -> TaskDemoTrigger -> Task SOQL
     */
    @AuraEnabled
    public static String runSuccessDemoTransaction() {
        system.debug('Running successful Lead transaction demo...');
        Lead demoLead = new Lead(
            FirstName = 'Demo',
            LastName = 'Lead ' + String.valueOf(Datetime.now().getTime()).substring(5),
            Company = 'Antigravity Visualizer Corp',
            Status = 'Open - Not Contacted',
            LeadSource = 'Web'
        );
        insert demoLead;
        return demoLead.Id;
    }

    /**
     * @description Executes a failing Lead transaction to test error highlighting and failure banners.
     */
    @AuraEnabled
    public static String runValidationFailureDemoTransaction() {
        try {
            Lead failLead = new Lead(
                FirstName = 'Failing',
                LastName = 'Demo Lead',
                Company = 'FAIL_VALIDATION',
                Status = 'Open - Not Contacted'
            );
            insert failLead;
            return failLead.Id;
        } catch (Exception ex) {
            System.debug('Expected Demo Exception: ' + ex.getMessage());
            return 'ERROR: ' + ex.getMessage();
        }
    }
}

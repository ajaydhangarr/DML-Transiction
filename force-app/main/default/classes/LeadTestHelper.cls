/**
 * @description Helper class to demonstrate calling Apex class methods 
 * from Lead triggers with debug statements for testing.
 */
public with sharing class LeadTestHelper {

    /**
     * @description Processes lead records and outputs structured debug statements.
     * @param leads List of Lead records from trigger context
     */
    public static void performTestOperations(List<Lead> leads) {
        System.debug('=== [LeadTestHelper] Starting Lead Test Operations ===');
        System.debug('[LeadTestHelper] Total Leads received in Trigger context: ' + (leads != null ? leads.size() : 0));

        if (leads == null || leads.isEmpty()) {
            System.debug('[LeadTestHelper] No leads to process.');
            return;
        }

        for (Integer i = 0; i < leads.size(); i++) {
            Lead ld = leads[i];
            System.debug('--- Processing Record #' + (i + 1) + ' ---');
            System.debug('[LeadTestHelper] Name: ' + ld.FirstName + ' ' + ld.LastName);
            System.debug('[LeadTestHelper] Company: ' + ld.Company);
            System.debug('[LeadTestHelper] Status: ' + ld.Status);
            System.debug('[LeadTestHelper] LeadSource: ' + ld.LeadSource);

            // Dummy calculation for testing debug outputs
            String leadRating = evaluateLeadRating(ld.Company, ld.LeadSource);
            System.debug('[LeadTestHelper] Evaluated Lead Rating: ' + leadRating);
        }

        System.debug('=== [LeadTestHelper] Finished Lead Test Operations at: ' + Datetime.now() + ' ===');
    }

    /**
     * @description Helper logic to calculate a test rating.
     */
    private static String evaluateLeadRating(String company, String leadSource) {
        if (company != null && company.containsIgnoreCase('Antigravity')) {
            return 'Hot';
        } else if (leadSource == 'Web') {
            return 'Warm';
        }
        return 'Cold';
    }
}

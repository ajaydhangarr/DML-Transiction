/**
 * @description Enterprise interface defining standard contract for log parsing strategies.
 * Enables extensible log parsing for Salesforce Debug Logs, Event Monitoring, and Platform Events.
 * 
 * @author Senior Salesforce Architect
 * @date 2026-07-31
 */
public interface ILogParser {
    /**
     * @description Parses a debug log body for a given ApexLog record and returns the primary transaction wrapper.
     * @param log ApexLog record query context
     * @param logBody Raw debug log text content
     * @return Primary DebugTransactionWrapper
     */
    DebugLogController.DebugTransactionWrapper parse(ApexLog log, String logBody);

    /**
     * @description Parses a debug log body and returns all DML transaction wrappers extracted from the log.
     * @param log ApexLog record query context
     * @param logBody Raw debug log text content
     * @return List of DebugTransactionWrapper entries (one per DML operation or main transaction)
     */
    List<DebugLogController.DebugTransactionWrapper> parseAll(ApexLog log, String logBody);
}
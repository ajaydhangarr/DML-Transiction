import { buildExecutionTreeAsync, extractDmlCardResult } from "../dmlLogParser";

describe("dmlLogParser async Apex nodes", () => {
  it("adds Future and Queueable invocation nodes under the parent DML tree", async () => {
    const rawLog = [
      "10:00:00.000 (100)|EXECUTION_STARTED",
      "10:00:00.001 (101)|DML_BEGIN|Op:Insert|Type:Account|Rows:1",
      "10:00:00.002 (102)|CODE_UNIT_STARTED|[EXTERNAL]|AccountContactTrigger on Account trigger event AfterInsert",
      "10:00:00.003 (103)|METHOD_ENTRY|[1]|01p|DmlVizFutureProbe.run(Id)",
      "10:00:00.004 (104)|METHOD_EXIT|[1]|01p|DmlVizFutureProbe.run(Id)",
      "10:00:00.005 (105)|METHOD_ENTRY|[2]|01p|DmlVizQueueableProbe.DmlVizQueueableProbe(Id)",
      "10:00:00.006 (106)|METHOD_EXIT|[2]|01p|DmlVizQueueableProbe.DmlVizQueueableProbe(Id)",
      "10:00:00.007 (107)|SYSTEM_METHOD_ENTRY|[3]|System.enqueueJob",
      "10:00:00.008 (108)|SYSTEM_METHOD_EXIT|[3]|System.enqueueJob",
      "10:00:00.009 (109)|CODE_UNIT_FINISHED|AccountContactTrigger on Account trigger event AfterInsert",
      "10:00:00.010 (110)|DML_END|[4]",
      "10:00:00.011 (111)|EXECUTION_FINISHED"
    ].join("\n");

    const tree = await buildExecutionTreeAsync(rawLog);
    const result = await extractDmlCardResult(tree, {
      includeInferredUiSaves: false
    });
    const flatten = (actions) =>
      (actions || []).flatMap((action) => [
        action,
        ...flatten(action.children)
      ]);
    const asyncNodes = flatten(result.cards[0].actions).filter(
      (action) => action.type === "ASYNC_APEX"
    );

    expect(asyncNodes.map((action) => action.label)).toEqual([
      "Future Apex",
      "Queueable Apex"
    ]);
    expect(asyncNodes.map((action) => action.name)).toEqual([
      "DmlVizFutureProbe.run(Id)",
      "DmlVizQueueableProbe.DmlVizQueueableProbe(Id)"
    ]);
  });
});

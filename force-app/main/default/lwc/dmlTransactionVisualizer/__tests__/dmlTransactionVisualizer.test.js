import { createElement } from "lwc";
import DmlTransactionVisualizer from "c/dmlTransactionVisualizer";
import getQueueLogs from "@salesforce/apex/DebugLogController.getQueueLogs";

jest.mock(
  "@salesforce/apex/DebugLogController.getQueueLogs",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("c-dml-transaction-visualizer", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.clearAllMocks();
  });

  it("shows a friendly queue error when loading logs fails", async () => {
    getQueueLogs.mockRejectedValue({
      body: { message: "CalloutException: secret endpoint data" }
    });
    const element = createElement("c-dml-transaction-visualizer", {
      is: DmlTransactionVisualizer
    });
    document.body.appendChild(element);
    await flushPromises();

    const errorBanner = element.shadowRoot.querySelector(".queue-debug-error");
    expect(errorBanner).not.toBeNull();
    expect(errorBanner.textContent).toContain(
      "We could not load recent Apex debug logs. Please click Refresh and try again."
    );
    expect(errorBanner.textContent).not.toContain("secret endpoint data");
  });

  it("renders the empty state with a blocked-log count", async () => {
    getQueueLogs.mockResolvedValue({
      pendingLogs: [],
      blockedLogs: [{ Id: "log-1" }, { Id: "log-2" }]
    });
    const element = createElement("c-dml-transaction-visualizer", {
      is: DmlTransactionVisualizer
    });
    document.body.appendChild(element);
    await flushPromises();

    expect(
      element.shadowRoot.querySelector(".empty-panel").textContent
    ).toContain("2 recent log(s) could not be analyzed");
  });
});

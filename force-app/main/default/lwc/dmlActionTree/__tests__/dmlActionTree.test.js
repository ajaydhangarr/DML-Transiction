import { createElement } from "lwc";
import DmlActionTree from "c/dmlActionTree";

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("c-dml-action-tree", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it("renders friendly labels and error styling for failed actions", async () => {
    const element = createElement("c-dml-action-tree", { is: DmlActionTree });
    element.actions = [
      {
        key: "error-1",
        type: "FLOW_ELEMENT_ERROR",
        label: "Flow Error",
        name: "Validation failed",
        detail: "The record is invalid",
        timestampStr: "10:00:00",
        durationMs: 25,
        hasChildren: false,
        defaultExpanded: false
      }
    ];
    document.body.appendChild(element);
    await flushPromises();

    const row = element.shadowRoot.querySelector(".tree-node");
    expect(row.className).toContain("error-node");
    expect(row.querySelector(".action-label").textContent).toContain(
      "Flow Error"
    );
  });

  it("limits visible nodes and exposes that the limit was reached", () => {
    const element = createElement("c-dml-action-tree", { is: DmlActionTree });
    element.actions = Array.from({ length: 1001 }, (_, index) => ({
      key: `event-${index}`,
      type: "USER_DEBUG",
      name: `Event ${index}`,
      hasChildren: false
    }));
    document.body.appendChild(element);

    expect(element.shadowRoot.querySelectorAll(".tree-node")).toHaveLength(
      1000
    );
    expect(
      element.shadowRoot.querySelector(".tree-limit-message").textContent
    ).toContain("1,000");
  });
});

import { APP_METHODS, type AppMethod } from "../../../modules-sdk/js/app.ts";
import { createWorkbenchApplication } from "../../../renderer/src/workspace/application.ts";
import { documentFromText } from "../../../renderer/src/workspace/model.ts";
import type { ApplicationServices } from "./application.ts";
export function fixture() {
  const documents = [
    documentFromText("notes/A.md", "# Alpha 한글 🌍\n[[B]]\n"),
    documentFromText("notes/B.md", "# Beta\n[[A]]\n"),
    documentFromText("src/main.ts", "const answer = 42;"),
  ];
  const events: string[] = [];
  let active = documents[0].id;
  const panels: Record<string, unknown> = {};
  const app = createWorkbenchApplication({
    documents: () => documents,
    active: () => ({ type: "document", documentId: active }),
    mode: () => "develop",
    edit: (id, text) => {
      documents.find((d) => d.id === id)!.content = text;
      app.changed(id);
    },
    open: (id) => {
      active = id;
    },
    layout: (value) => Object.assign(panels, value),
    notify: (text) => {
      events.push(text);
    },
    output: (text) => {
      events.push(text);
    },
  });
  const service: ApplicationServices = {
    methods: () =>
      Object.keys(APP_METHODS).filter((x) =>
        x !== "commands.list"
      ) as AppMethod[],
    request: (method, parameters, caller) =>
      Promise.resolve(app.invoke(method, parameters, caller.moduleId)),
  };
  return { app, service, documents, events, panels };
}

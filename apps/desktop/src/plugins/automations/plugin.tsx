// Buttons and triggers (ADR 0072). Below a `meta-bind-button` code block's
// code, the button it writes, in Meta Bind's syntax, which runs its actions
// through the app. And for each property the app changes on this device,
// the triggers of the row's database. Both reach the host, its command
// registry, its notes and its changes, so this is a built-in plugin's
// work; an exported page shows a button's code.
import { buttonLanguage } from "@nether/automations";
import { ButtonView } from "../../ButtonView.tsx";
import { runTriggers } from "../../triggers.ts";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.codeBlocks.view(buttonLanguage, (props) => <ButtonView {...props} />);
    context.host.properties.watch((change) => runTriggers(change));
  },
};

export default plugin;

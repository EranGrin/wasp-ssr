// @ts-nocheck
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { getWaspApp } from "wasp/client/app";
import { routesMapping } from "/@wasp/routes.tsx"
import { routeNameToSsr } from "/@wasp/routes.tsx"

import { App as App_ext } from './src/App'

import { setup as setup_ext } from './src/clientSetup'

await setup_ext()

const app = getWaspApp({
  rootElement: <App_ext />,
  routesMapping: routesMapping,
  routeNameToSsr: routeNameToSsr,
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const appWithProviders = <React.StrictMode>{app}</React.StrictMode>;

if (rootElement.dataset.waspSsr === "1") {
  ReactDOM.hydrateRoot(rootElement, appWithProviders);
} else {
  ReactDOM.createRoot(rootElement).render(appWithProviders);
}

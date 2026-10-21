// @ts-nocheck
import { lazy, Suspense, createElement } from 'react';

// Static imports for SSR-enabled pages (included in the SSR bundle):
import * as MainPage from './src/MainPage'

function getOptionalExport(mod, exportName) {
  return mod && typeof mod === "object" ? mod[exportName] : undefined;
}

// Helper: wraps a dynamic import() in React.lazy + Suspense so the page
// is code-split and excluded from the SSR bundle.
function createLazyPage(loader) {
  const LazyComponent = lazy(loader);
  return function LazyPage(props) {
    return createElement(Suspense, { fallback: null }, createElement(LazyComponent, props));
  };
}

// Lazy imports for non-SSR pages (excluded from the SSR bundle):

export const routesMapping = {
  RootRoute: MainPage.MainPage,
} as const;

export const routeNameToSsr = {
  RootRoute: false,
} as const;

export const routeNameToHead = {
  RootRoute: getOptionalExport(MainPage, "head"),
} as const;

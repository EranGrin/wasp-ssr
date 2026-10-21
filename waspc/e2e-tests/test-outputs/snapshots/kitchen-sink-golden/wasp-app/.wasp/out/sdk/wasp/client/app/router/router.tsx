import * as React from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { OAuthCallbackPage } from "../pages/OAuthCallback"

import { DefaultRootErrorBoundary } from '../components/DefaultRootErrorBoundary'

import { routes } from '../../router/index'

export function getRouter({
  routesMapping,
  rootElement,
  routeNameToSsr,
}: {
  routesMapping: Record<string, React.ComponentType>,
  rootElement: React.ReactNode,
  routeNameToSsr: Record<string, boolean>,
}) {
  const waspDefinedRoutes = [
    {
      path: "/oauth/callback",
      Component: OAuthCallbackPage,
      handle: { ssr: false },
    },
  ]
  const userDefinedRoutes = Object.entries(routes).map(([routeKey, route]) => {
    return {
      path: route.to,
      Component: routesMapping[routeKey],
      handle: { ssr: routeNameToSsr[routeKey] ?? false },
    }
  })

  const browserRouter = createBrowserRouter([{
    path: '/',
    element: rootElement,
    ErrorBoundary: DefaultRootErrorBoundary,
    children: [
      ...waspDefinedRoutes,
      ...userDefinedRoutes,
    ],
  }], {
    basename: '/',
  })
  return <RouterProvider router={browserRouter} />;
}

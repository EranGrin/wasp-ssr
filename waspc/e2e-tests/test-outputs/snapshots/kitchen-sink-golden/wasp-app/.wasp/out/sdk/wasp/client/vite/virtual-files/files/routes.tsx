// @ts-nocheck
import { lazy, Suspense, createElement } from 'react';
import { createAuthRequiredPage } from "wasp/client/app"

// Static imports for SSR-enabled pages (included in the SSR bundle):
import * as HomePage from './src/pages/HomePage'
import * as CatchAllPage from './src/pages/CatchAllPage'
import * as SignupPage from './src/features/auth/pages/Signup'
import * as LoginPage from './src/features/auth/pages/Login'
import * as PasswordResetPage from './src/features/auth/pages/PasswordReset'
import * as EmailVerificationPage from './src/features/auth/pages/EmailVerification'
import * as RequestPasswordResetPage from './src/features/auth/pages/RequestPasswordReset'
import * as ProfilePage from './src/features/auth/pages/ProfilePage'
import * as ManualSignupPage from './src/features/auth/pages/ManualSignupPage'
import * as CustomSignupPage from './src/features/auth/pages/CustomSignupPage'
import * as TasksPage from './src/features/operations/pages/TasksPage'
import * as TaskPage from './src/features/operations/pages/TaskDetailPage'
import * as SerializationPage from './src/features/operations/pages/SerializationPage'
import * as JobsPage from './src/features/jobs/pages/JobsPage'
import * as ApisPage from './src/features/apis/pages/ApisPage'
import * as CrudList from './src/features/crud/pages/ListPage'
import * as CrudDetail from './src/features/crud/pages/DetailPage'
import * as StreamingPage from './src/features/streaming/pages/StreamingTestPage'
import * as ChatPage from './src/features/chat/pages/ChatPage'

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
  HomeRoute: HomePage.HomePage,
  CatchAllRoute: CatchAllPage.CatchAllPage,
  SignupRoute: SignupPage.default,
  LoginRoute: LoginPage.default,
  PasswordResetRoute: PasswordResetPage.PasswordReset,
  EmailVerificationRoute: EmailVerificationPage.EmailVerification,
  RequestPasswordResetRoute: RequestPasswordResetPage.RequestPasswordReset,
  ProfileRoute: createAuthRequiredPage(ProfilePage.ProfilePage),
  ManualSignupRoute: ManualSignupPage.ManualSignupPage,
  CustomSignupRoute: CustomSignupPage.CustomSignupPage,
  TasksRoute: createAuthRequiredPage(TasksPage.TasksPage),
  TaskRoute: createAuthRequiredPage(TaskPage.TaskDetailPage),
  SerializationRoute: SerializationPage.SerializationPage,
  JobsRoute: createAuthRequiredPage(JobsPage.JobsPage),
  ApisRoute: ApisPage.ApisPage,
  CrudListRoute: createAuthRequiredPage(CrudList.ListPage),
  CrudDetailRoute: createAuthRequiredPage(CrudDetail.DetailPage),
  StreamingRoute: StreamingPage.StreamingTestPage,
  ChatRoute: createAuthRequiredPage(ChatPage.ChatPage),
} as const;

export const routeNameToSsr = {
  HomeRoute: false,
  CatchAllRoute: false,
  SignupRoute: false,
  LoginRoute: false,
  PasswordResetRoute: false,
  EmailVerificationRoute: false,
  RequestPasswordResetRoute: false,
  ProfileRoute: false,
  ManualSignupRoute: false,
  CustomSignupRoute: false,
  TasksRoute: false,
  TaskRoute: false,
  SerializationRoute: false,
  JobsRoute: false,
  ApisRoute: false,
  CrudListRoute: false,
  CrudDetailRoute: false,
  StreamingRoute: false,
  ChatRoute: false,
} as const;

export const routeNameToHead = {
  HomeRoute: getOptionalExport(HomePage, "head"),
  CatchAllRoute: getOptionalExport(CatchAllPage, "head"),
  SignupRoute: getOptionalExport(SignupPage, "head"),
  LoginRoute: getOptionalExport(LoginPage, "head"),
  PasswordResetRoute: getOptionalExport(PasswordResetPage, "head"),
  EmailVerificationRoute: getOptionalExport(EmailVerificationPage, "head"),
  RequestPasswordResetRoute: getOptionalExport(RequestPasswordResetPage, "head"),
  ProfileRoute: getOptionalExport(ProfilePage, "head"),
  ManualSignupRoute: getOptionalExport(ManualSignupPage, "head"),
  CustomSignupRoute: getOptionalExport(CustomSignupPage, "head"),
  TasksRoute: getOptionalExport(TasksPage, "head"),
  TaskRoute: getOptionalExport(TaskPage, "head"),
  SerializationRoute: getOptionalExport(SerializationPage, "head"),
  JobsRoute: getOptionalExport(JobsPage, "head"),
  ApisRoute: getOptionalExport(ApisPage, "head"),
  CrudListRoute: getOptionalExport(CrudList, "head"),
  CrudDetailRoute: getOptionalExport(CrudDetail, "head"),
  StreamingRoute: getOptionalExport(StreamingPage, "head"),
  ChatRoute: getOptionalExport(ChatPage, "head"),
} as const;

import { useEffect, useState } from "react";
import { AlertCircle, KeyRound, LayoutDashboard, LoaderCircle, LogOut, UserRound } from "lucide-react";
import { api, ApiError, type PortalEntryManifest, type PortalUser } from "./api";
import AdminDashboard from "./AdminDashboard";
import LoginPage from "./features/auth/LoginPage";
import PasswordDialog from "./features/auth/PasswordDialog";
import PasswordSetupPage from "./features/auth/PasswordSetupPage";
import { useAuthSession } from "./features/auth/useAuthSession";
import WorkspaceEntryPage from "./features/entry/WorkspaceEntryPage";
import UnavailableEntryPage from "./features/entry/UnavailableEntryPage";
import EntryLoadingPage from "./features/entry/EntryLoadingPage";
import { resolvePortalRoute } from "./features/entry/user-entry-flow";
import UserDashboard from "./features/instances/UserDashboard";
import { formatAuthError } from "./auth-i18n";
import { ADMIN_VIEWS, type AdminView } from "./navigation";
import { isManagementRole, userRoleLabel } from "./user-role";
import { authApi } from "./auth-api";

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="notice error">
      <AlertCircle size={17} />
      <span>{message}</span>
    </div>
  );
}

function BrandLogo({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand-mark${small ? " small" : ""}`}>
      <img src="/openapp-logo.png" alt="" />
    </div>
  );
}

type ShellView = "user" | "admin";

interface ShellLocation {
  view: ShellView;
  adminView: AdminView;
}

function readShellLocation(user: PortalUser): ShellLocation {
  const search = new URLSearchParams(window.location.search);
  const requestedView = search.get("view");
  const requestedAdminView = search.get("admin");
  const adminView = ADMIN_VIEWS.find((view) => view === requestedAdminView) ?? "overview";
  return {
    view: isManagementRole(user.role) && requestedView !== "user" ? "admin" : "user",
    adminView,
  };
}

function Shell({
  user,
  onLogout,
  onUserChange,
}: {
  user: PortalUser;
  onLogout: () => Promise<void>;
  onUserChange: (user: PortalUser) => void;
}) {
  const [logoutError, setLogoutError] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [location, setLocation] = useState<ShellLocation>(() => readShellLocation(user));
  useEffect(() => {
    const restoreLocation = () => setLocation(readShellLocation(user));
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [user]);
  function navigate(next: ShellLocation) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", next.view);
    url.searchParams.set("admin", next.adminView);
    window.history.pushState(null, "", url);
    setLocation(next);
  }
  async function logout() {
    setLogoutError("");
    try {
      await onLogout();
    } catch (reason) {
      setLogoutError(formatAuthError(reason, "退出登录失败，请稍后重试。", "zh-CN"));
    }
  }
  return (
    <div className="app-shell">
      <header>
        <a className="logo" href="/control">
          <BrandLogo small />
          <span>OpenApp</span>
        </a>
        <div className="account">
          <div>
            <strong>{user.name ?? user.email}</strong>
            <span>{userRoleLabel(user.role)}</span>
          </div>
          {isManagementRole(user.role) && (
            <button className="icon-button" title="修改密码" onClick={() => setPasswordOpen(true)}>
              <KeyRound size={18} />
            </button>
          )}
          <button className="icon-button" title="退出登录" onClick={() => void logout()}>
            <LogOut size={18} />
          </button>
        </div>
      </header>
      {isManagementRole(user.role) && (
        <nav className="role-switch" aria-label="页面模式">
          <button
            className={location.view === "user" ? "active" : ""}
            onClick={() => navigate({ ...location, view: "user" })}
          >
            <UserRound size={16} />
            普通用户页面
          </button>
          <button
            className={location.view === "admin" ? "active" : ""}
            onClick={() => navigate({ ...location, view: "admin" })}
          >
            <LayoutDashboard size={16} />
            管理员页面
          </button>
        </nav>
      )}
      {logoutError && (
        <div className="shell-notice">
          <ErrorNotice message={logoutError} />
        </div>
      )}
      {location.view === "admin" && isManagementRole(user.role) ? (
        <AdminDashboard
          currentUser={user}
          view={location.adminView}
          onViewChange={(adminView) => navigate({ view: "admin", adminView })}
        />
      ) : (
        <UserDashboard />
      )}
      {isManagementRole(user.role) && passwordOpen && (
        <PasswordDialog
          user={user}
          onClose={() => setPasswordOpen(false)}
          onChanged={(nextUser) => {
            onUserChange(nextUser);
            setPasswordOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ControlApp() {
  const { user, loading, sessionError, authenticate, logout } = useAuthSession();
  if (loading)
    return (
      <div className="splash">
        <BrandLogo />
        <LoaderCircle className="spin" />
      </div>
    );
  if (!user) return <LoginPage onLogin={authenticate} initialError={sessionError} />;
  if (isManagementRole(user.role) && user.passwordSetupRequired)
    return <PasswordSetupPage user={user} onComplete={authenticate} />;
  return <Shell user={user} onLogout={logout} onUserChange={authenticate} />;
}

function WorkspaceApp() {
  const { user, loading, sessionError, authenticate } = useAuthSession();
  // 入口状态由当前服务的插件注册结果决定，不依据历史目录数据推断。
  const [manifest, setManifest] = useState<PortalEntryManifest>();
  const [entryState, setEntryState] = useState<"loading" | "ready" | "missing" | "unavailable">("loading");
  useEffect(() => {
    let active = true;
    api
      .entryManifest()
      .then((nextManifest) => {
        if (active) {
          setManifest(nextManifest);
          setEntryState("ready");
        }
      })
      .catch(async (error: unknown) => {
        // 仅旧网关缺少入口接口且认证合同明确兼容时回退；网络及服务异常不降级。
        if (error instanceof ApiError && [404, 501].includes(error.status)) {
          try {
            const methods = await authApi.methods();
            if (
              methods.compatibilityMode === true ||
              (methods.compatibilityMode === undefined && methods.authProviderId === undefined)
            ) {
              if (active) setEntryState("ready");
              return;
            }
          } catch {
            /* 认证合同无法确认时保持不可用状态。 */
          }
        }
        if (active)
          setEntryState(
            error instanceof ApiError && error.code === "adapter_not_configured" ? "missing" : "unavailable",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  if (entryState === "missing" || entryState === "unavailable")
    return <UnavailableEntryPage missing={entryState === "missing"} />;
  if (loading || entryState === "loading") return <EntryLoadingPage />;
  if (!user)
    return (
      <LoginPage mode="workspace" onLogin={authenticate} initialError={sessionError} manifest={manifest} />
    );
  return <WorkspaceEntryPage />;
}

function Redirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);
  return (
    <div className="splash">
      <LoaderCircle className="spin" />
    </div>
  );
}

export default function App() {
  const route = resolvePortalRoute(window.location.pathname, window.location.search);
  if (route.mode === "redirect") return <Redirect url={route.url ?? "/control"} />;
  if (route.mode === "control") return <ControlApp />;
  if (route.mode === "instance") return null;
  return <WorkspaceApp />;
}

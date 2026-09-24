import { useEffect, useState } from 'react';
import { authApi } from '../../auth-api';
import type { PortalUser } from '../../api';

export function useAuthSession() {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<unknown>(null);

  useEffect(() => {
    authApi.session()
      .then((session) => { if (session.authenticated) setUser(session.user); })
      .catch((reason) => setSessionError(reason))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await authApi.logout();
    setUser(null);
  }

  function authenticate(nextUser: PortalUser) {
    setSessionError(null);
    setUser(nextUser);
  }

  return { user, loading, sessionError, authenticate, logout };
}

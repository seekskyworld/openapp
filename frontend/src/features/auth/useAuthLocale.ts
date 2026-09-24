import { useEffect, useState } from 'react';
import { resolveAuthLocale, type AuthLocale } from '../../auth-i18n';

export function useAuthLocale(): [AuthLocale, (locale: AuthLocale) => void] {
  const [locale, setLocale] = useState<AuthLocale>(resolveAuthLocale);

  useEffect(() => {
    const root = document.documentElement;
    const previousLanguage = root.lang;
    root.lang = locale;
    return () => { root.lang = previousLanguage; };
  }, [locale]);

  return [locale, setLocale];
}

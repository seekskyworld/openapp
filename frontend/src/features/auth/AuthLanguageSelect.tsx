import { Globe2, Languages } from 'lucide-react';
import { authLocaleOptions, authMessages, type AuthLocale } from '../../auth-i18n';

export default function AuthLanguageSelect({
  className,
  locale,
  onChange,
  variant = 'select',
}: {
  className: string;
  locale: AuthLocale;
  onChange: (locale: AuthLocale) => void;
  variant?: 'select' | 'toggle';
}) {
  const copy = authMessages(locale);
  if (variant === 'toggle') {
    const nextLocale = locale === 'en' ? 'zh-CN' : 'en';
    const nextOption = authLocaleOptions.find((option) => option.locale === nextLocale)!;
    return <button
      className={`auth-language-toggle ${className} notranslate imt-notranslate`}
      type="button"
      translate="no"
      aria-label={copy.switchLanguage(nextOption.nativeLabel)}
      onClick={() => onChange(nextLocale)}
    >
      <Globe2 size={15} aria-hidden="true" />
      <span>{nextOption.shortLabel}</span>
    </button>;
  }

  const label = copy.languageLabel;
  const id = `${className}-select`;
  return <div className={`auth-language-selector ${className}`}>
    <Languages size={15} aria-hidden="true" />
    <label className="sr-only" htmlFor={id}>{label}</label>
    <select
      id={id}
      value={locale}
      aria-label={label}
      onChange={(event) => onChange(event.currentTarget.value as AuthLocale)}
    >
      {authLocaleOptions.map((option) => <option key={option.locale} value={option.locale}>
        {option.label}
      </option>)}
    </select>
  </div>;
}

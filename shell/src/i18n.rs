//! Match the user's preferred OS display language; unsupported locales use English.
use slint::ComponentHandle;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    English,
    Chinese,
}

impl Language {
    fn from_locale(locale: &str) -> Self {
        let primary = locale
            .trim()
            .split(['-', '_', '.', '@'])
            .next()
            .unwrap_or("");
        if primary.eq_ignore_ascii_case("zh") {
            Self::Chinese
        } else {
            Self::English
        }
    }

    pub fn tag(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Chinese => "zh",
        }
    }

    pub fn text(self, english: &'static str, chinese: &'static str) -> &'static str {
        match self {
            Self::English => english,
            Self::Chinese => chinese,
        }
    }
}

fn resolve(override_locale: Option<&str>, system_locale: Option<&str>) -> Language {
    let explicit = override_locale
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"));
    Language::from_locale(explicit.or(system_locale).unwrap_or("en"))
}

pub fn detect() -> Language {
    // sys-locale uses GetUserPreferredUILanguages on Windows and preferred OS
    // languages on Apple platforms; Unix follows the locale environment.
    let explicit = std::env::var("MINITRON_LANG").ok();
    let system = sys_locale::get_locale();
    resolve(explicit.as_deref(), system.as_deref())
}

pub fn apply(window: &crate::ShellWindow) {
    window
        .global::<crate::I18n>()
        .set_language(detect().tag().into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_regions_scripts_and_posix_locales_use_chinese() {
        for locale in [
            "zh",
            "zh-CN",
            "zh-TW",
            "zh-HK",
            "zh-Hans-CN",
            "zh-Hant",
            "ZH_cn.UTF-8",
            " zh_SG@variant ",
        ] {
            assert_eq!(Language::from_locale(locale), Language::Chinese, "{locale}");
        }
    }

    #[test]
    fn english_is_the_default_for_unsupported_or_missing_locales() {
        for locale in [
            "en", "en-US", "de-DE", "ja-JP", "C", "POSIX", "", "zhong", "x-zh",
        ] {
            assert_eq!(Language::from_locale(locale), Language::English, "{locale}");
        }
        assert_eq!(resolve(None, None), Language::English);
    }

    #[test]
    fn explicit_language_wins_and_auto_uses_the_system_preference() {
        assert_eq!(resolve(Some("en"), Some("zh-CN")), Language::English);
        assert_eq!(resolve(Some("zh"), Some("en-US")), Language::Chinese);
        assert_eq!(resolve(Some("AUTO"), Some("zh-CN")), Language::Chinese);
        assert_eq!(resolve(Some(" "), Some("zh-TW")), Language::Chinese);
        assert_eq!(resolve(Some("fr"), Some("zh-CN")), Language::English);
        assert_eq!(resolve(None, Some("en-US")), Language::English);
    }
}

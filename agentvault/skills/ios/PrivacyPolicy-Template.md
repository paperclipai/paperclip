# App Store Privacy Policy Template

**Skill ID:** `privacy-policy-template`
**Version:** 1.0.0
**Quality Gates:** `privacy-flags`

---

## Overview

Every app on the App Store must link to a privacy policy and declare its
data-collection practices in App Store Connect. Since iOS 17, apps must also
include a `PrivacyInfo.xcprivacy` file in their bundle. This skill provides:

1. A plain-English privacy policy template.
2. A `PrivacyInfo.xcprivacy` starter template.
3. The `NSPrivacyCollectedDataTypes` checklist.
4. Common rejection reasons and how to avoid them.

---

## 1. Privacy Policy Template

Copy, fill in the bracketed fields, and host the resulting document at a
stable URL (e.g. GitHub Pages, your marketing site).

```markdown
# Privacy Policy for [App Name]

**Last updated:** [YYYY-MM-DD]

## 1. Who We Are
[Company/Developer Name] ("we", "our", "us") operates [App Name] (the "App").

## 2. Data We Collect

| Category | Data Points | Why | Retention |
|----------|-------------|-----|-----------|
| Identity | [e.g. Display name] | [e.g. Personalise UI] | [e.g. Until account deletion] |
| Usage | [e.g. Feature taps, crash logs] | [e.g. Product improvement] | [e.g. 90 days] |
| Location | [None / Coarse / Precise] | [Purpose if collected] | [Duration] |
| Camera/Mic | [None / Camera / Mic / Both] | [Purpose if collected] | [Not stored / Duration] |

If you do not collect a category, state "We do not collect [category] data."

## 3. How We Use Your Data
We use collected data solely for the purposes listed above.
We do not sell, rent, or trade personal data to third parties.

## 4. Third-Party Services
[List any SDKs / analytics / crash reporters, e.g. Firebase Crashlytics]
Each third party has its own privacy policy. Links: [...]

## 5. Data Storage & Security
Data is stored [locally on device / on servers in {region}].
We use [encryption standard, e.g. AES-256] for data at rest.
Transmission is protected by TLS 1.2+.

## 6. Children's Privacy
The App is not directed at children under 13.
We do not knowingly collect data from children under 13.
If you believe a child has provided data, contact us at [email].

## 7. Your Rights
Depending on your location you may have rights to access, correct, or delete
your data. Contact us at [email] to exercise these rights.

## 8. Changes to This Policy
We will notify you of material changes via [in-app notice / email].
Continued use after changes constitutes acceptance.

## 9. Contact
[Company Name]
[Address]
[support@example.com]
```

---

## 2. PrivacyInfo.xcprivacy Starter

Create `[TargetName]/PrivacyInfo.xcprivacy` in Xcode (File → New → Resource →
Privacy Manifest File). Minimum required content:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Required API reasons -->
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <!-- Example: UserDefaults -->
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>  <!-- Store app-specific preferences -->
            </array>
        </dict>
        <!-- Add entries for: FileTimestamp, SystemBootTime, DiskSpace, ActiveKeyboards -->
    </array>

    <!-- Data collection declarations -->
    <key>NSPrivacyCollectedDataTypes</key>
    <array>
        <!-- Fill one dict per data type you collect. Delete types you do NOT collect. -->

        <!-- Usage Data (required if you use analytics) -->
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeAppInteractions</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <false/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>

        <!-- Crash Data -->
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeCrashData</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <false/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>
    </array>

    <!-- Set true ONLY if you use ATT tracking -->
    <key>NSPrivacyTracking</key>
    <false/>
</dict>
</plist>
```

### Required API Reason Codes

| API Category | Common Reason Code | When to use |
|---|---|---|
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | Storing app preferences |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1` | File-management features |
| `NSPrivacyAccessedAPICategorySystemBootTime` | `35F9.1` | Measure elapsed time |
| `NSPrivacyAccessedAPICategoryDiskSpace` | `E174.1` | Prevent data loss warnings |
| `NSPrivacyAccessedAPICategoryActiveKeyboards` | `3EC4.1` | Custom keyboard extension |

---

## 3. NSPrivacyCollectedDataTypes Checklist

For every data type your app collects, add an entry in `PrivacyInfo.xcprivacy`
**and** disclose it in the App Store Connect privacy questionnaire.

- [ ] Name
- [ ] Email address
- [ ] Phone number
- [ ] Physical address
- [ ] Other user contact info
- [ ] Health & fitness data
- [ ] Financial info
- [ ] Location (precise)
- [ ] Location (coarse)
- [ ] Sensitive info
- [ ] Contacts
- [ ] Calendars
- [ ] Reminders
- [ ] Photos or videos
- [ ] Audio data
- [ ] Gameplay content
- [ ] Customer support data
- [ ] Other user content
- [ ] Browsing history
- [ ] Search history
- [ ] Identifiers (User ID, Device ID)
- [ ] Purchase history
- [ ] Product interaction / App interactions
- [ ] Advertising data
- [ ] Crash data
- [ ] Performance data
- [ ] Other diagnostic data
- [ ] Emails / text messages
- [ ] Other data types

---

## 4. Common App Store Rejection Reasons

| Reason | Fix |
|--------|-----|
| Privacy policy URL returns 404 | Host at a stable URL; use a redirect if needed |
| `PrivacyInfo.xcprivacy` missing | Add the file to every app target and extension |
| Declared data type doesn't match actual usage | Audit with Instruments → Privacy Report |
| `NSPrivacyTracking = true` without ATT prompt | Either set `false` or add `ATTrackingManager.requestTrackingAuthorization` |
| Missing required API reason code | Check Apple's required reason API list and add codes |
| Third-party SDK collects undeclared data | Review SDK privacy manifests via `xcodebuild -generatePrivacyReport` |

---

## 5. Generating the Privacy Report in Xcode

```bash
xcodebuild -scheme MyApp \
           -destination 'platform=iOS Simulator,name=iPhone 15' \
           -generatePrivacyReport \
           -resultBundlePath ./PrivacyReport.xcresult
```

Open `PrivacyReport.xcresult` in Xcode to see a full list of API accesses and
missing reason codes from your app and all linked SDKs.

---

## Quality Gate: `privacy-flags`

| Check | Pass Condition |
|-------|---------------|
| `PrivacyInfo.xcprivacy` present | File exists in every app target |
| `NSPrivacyTracking` declared | Key present; `true` only if ATT flow implemented |
| `NSPrivacyCollectedDataTypes` non-empty | At least one entry present (even if only CrashData) |
| Privacy policy URL in `Info.plist` | `NSPrivacyPolicyURL` key set |
| Required API reasons declared | All APIs in Apple's required-reason list have at least one reason code |

---

## References

- [Apple – Privacy Nutrition Labels](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple – Privacy Manifest Files](https://developer.apple.com/documentation/bundleresources/privacy_manifest_files)
- [Apple – Required Reason APIs](https://developer.apple.com/documentation/bundleresources/privacy_manifest_files/describing_use_of_required_reason_api)
- [App Store Review Guidelines §5.1](https://developer.apple.com/app-store/review/guidelines/#privacy)

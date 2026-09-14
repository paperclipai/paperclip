/*!
 * Platform rules from OpenAI Codex, copyright OpenAI.
 * https://github.com/openai/codex/tree/7efa9d96fb34c3cafe108a3c870bfc33e5635772/codex-rs/sandboxing/src
 * The base, read-only platform and network rules are included. The separate
 * process defaults granting shared temporary-directory access are omitted.
 * This TypeScript packaging and the workspace rules are Paperclip additions.
 *
 *                                  Apache License
 *                            Version 2.0, January 2004
 *                         http://www.apache.org/licenses/
 * 
 * TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
 * 
 * 1.  Definitions.
 * 
 *     "License" shall mean the terms and conditions for use, reproduction,
 *     and distribution as defined by Sections 1 through 9 of this document.
 * 
 *     "Licensor" shall mean the copyright owner or entity authorized by
 *     the copyright owner that is granting the License.
 * 
 *     "Legal Entity" shall mean the union of the acting entity and all
 *     other entities that control, are controlled by, or are under common
 *     control with that entity. For the purposes of this definition,
 *     "control" means (i) the power, direct or indirect, to cause the
 *     direction or management of such entity, whether by contract or
 *     otherwise, or (ii) ownership of fifty percent (50%) or more of the
 *     outstanding shares, or (iii) beneficial ownership of such entity.
 * 
 *     "You" (or "Your") shall mean an individual or Legal Entity
 *     exercising permissions granted by this License.
 * 
 *     "Source" form shall mean the preferred form for making modifications,
 *     including but not limited to software source code, documentation
 *     source, and configuration files.
 * 
 *     "Object" form shall mean any form resulting from mechanical
 *     transformation or translation of a Source form, including but
 *     not limited to compiled object code, generated documentation,
 *     and conversions to other media types.
 * 
 *     "Work" shall mean the work of authorship, whether in Source or
 *     Object form, made available under the License, as indicated by a
 *     copyright notice that is included in or attached to the work
 *     (an example is provided in the Appendix below).
 * 
 *     "Derivative Works" shall mean any work, whether in Source or Object
 *     form, that is based on (or derived from) the Work and for which the
 *     editorial revisions, annotations, elaborations, or other modifications
 *     represent, as a whole, an original work of authorship. For the purposes
 *     of this License, Derivative Works shall not include works that remain
 *     separable from, or merely link (or bind by name) to the interfaces of,
 *     the Work and Derivative Works thereof.
 * 
 *     "Contribution" shall mean any work of authorship, including
 *     the original version of the Work and any modifications or additions
 *     to that Work or Derivative Works thereof, that is intentionally
 *     submitted to Licensor for inclusion in the Work by the copyright owner
 *     or by an individual or Legal Entity authorized to submit on behalf of
 *     the copyright owner. For the purposes of this definition, "submitted"
 *     means any form of electronic, verbal, or written communication sent
 *     to the Licensor or its representatives, including but not limited to
 *     communication on electronic mailing lists, source code control systems,
 *     and issue tracking systems that are managed by, or on behalf of, the
 *     Licensor for the purpose of discussing and improving the Work, but
 *     excluding communication that is conspicuously marked or otherwise
 *     designated in writing by the copyright owner as "Not a Contribution."
 * 
 *     "Contributor" shall mean Licensor and any individual or Legal Entity
 *     on behalf of whom a Contribution has been received by Licensor and
 *     subsequently incorporated within the Work.
 * 
 * 2.  Grant of Copyright License. Subject to the terms and conditions of
 *     this License, each Contributor hereby grants to You a perpetual,
 *     worldwide, non-exclusive, no-charge, royalty-free, irrevocable
 *     copyright license to reproduce, prepare Derivative Works of,
 *     publicly display, publicly perform, sublicense, and distribute the
 *     Work and such Derivative Works in Source or Object form.
 * 
 * 3.  Grant of Patent License. Subject to the terms and conditions of
 *     this License, each Contributor hereby grants to You a perpetual,
 *     worldwide, non-exclusive, no-charge, royalty-free, irrevocable
 *     (except as stated in this section) patent license to make, have made,
 *     use, offer to sell, sell, import, and otherwise transfer the Work,
 *     where such license applies only to those patent claims licensable
 *     by such Contributor that are necessarily infringed by their
 *     Contribution(s) alone or by combination of their Contribution(s)
 *     with the Work to which such Contribution(s) was submitted. If You
 *     institute patent litigation against any entity (including a
 *     cross-claim or counterclaim in a lawsuit) alleging that the Work
 *     or a Contribution incorporated within the Work constitutes direct
 *     or contributory patent infringement, then any patent licenses
 *     granted to You under this License for that Work shall terminate
 *     as of the date such litigation is filed.
 * 
 * 4.  Redistribution. You may reproduce and distribute copies of the
 *     Work or Derivative Works thereof in any medium, with or without
 *     modifications, and in Source or Object form, provided that You
 *     meet the following conditions:
 * 
 *     (a) You must give any other recipients of the Work or
 *     Derivative Works a copy of this License; and
 * 
 *     (b) You must cause any modified files to carry prominent notices
 *     stating that You changed the files; and
 * 
 *     (c) You must retain, in the Source form of any Derivative Works
 *     that You distribute, all copyright, patent, trademark, and
 *     attribution notices from the Source form of the Work,
 *     excluding those notices that do not pertain to any part of
 *     the Derivative Works; and
 * 
 *     (d) If the Work includes a "NOTICE" text file as part of its
 *     distribution, then any Derivative Works that You distribute must
 *     include a readable copy of the attribution notices contained
 *     within such NOTICE file, excluding those notices that do not
 *     pertain to any part of the Derivative Works, in at least one
 *     of the following places: within a NOTICE text file distributed
 *     as part of the Derivative Works; within the Source form or
 *     documentation, if provided along with the Derivative Works; or,
 *     within a display generated by the Derivative Works, if and
 *     wherever such third-party notices normally appear. The contents
 *     of the NOTICE file are for informational purposes only and
 *     do not modify the License. You may add Your own attribution
 *     notices within Derivative Works that You distribute, alongside
 *     or as an addendum to the NOTICE text from the Work, provided
 *     that such additional attribution notices cannot be construed
 *     as modifying the License.
 * 
 *     You may add Your own copyright statement to Your modifications and
 *     may provide additional or different license terms and conditions
 *     for use, reproduction, or distribution of Your modifications, or
 *     for any such Derivative Works as a whole, provided Your use,
 *     reproduction, and distribution of the Work otherwise complies with
 *     the conditions stated in this License.
 * 
 * 5.  Submission of Contributions. Unless You explicitly state otherwise,
 *     any Contribution intentionally submitted for inclusion in the Work
 *     by You to the Licensor shall be under the terms and conditions of
 *     this License, without any additional terms or conditions.
 *     Notwithstanding the above, nothing herein shall supersede or modify
 *     the terms of any separate license agreement you may have executed
 *     with Licensor regarding such Contributions.
 * 
 * 6.  Trademarks. This License does not grant permission to use the trade
 *     names, trademarks, service marks, or product names of the Licensor,
 *     except as required for reasonable and customary use in describing the
 *     origin of the Work and reproducing the content of the NOTICE file.
 * 
 * 7.  Disclaimer of Warranty. Unless required by applicable law or
 *     agreed to in writing, Licensor provides the Work (and each
 *     Contributor provides its Contributions) on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 *     implied, including, without limitation, any warranties or conditions
 *     of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
 *     PARTICULAR PURPOSE. You are solely responsible for determining the
 *     appropriateness of using or redistributing the Work and assume any
 *     risks associated with Your exercise of permissions under this License.
 * 
 * 8.  Limitation of Liability. In no event and under no legal theory,
 *     whether in tort (including negligence), contract, or otherwise,
 *     unless required by applicable law (such as deliberate and grossly
 *     negligent acts) or agreed to in writing, shall any Contributor be
 *     liable to You for damages, including any direct, indirect, special,
 *     incidental, or consequential damages of any character arising as a
 *     result of this License or out of the use or inability to use the
 *     Work (including but not limited to damages for loss of goodwill,
 *     work stoppage, computer failure or malfunction, or any and all
 *     other commercial damages or losses), even if such Contributor
 *     has been advised of the possibility of such damages.
 * 
 * 9.  Accepting Warranty or Additional Liability. While redistributing
 *     the Work or Derivative Works thereof, You may choose to offer,
 *     and charge a fee for, acceptance of support, warranty, indemnity,
 *     or other liability obligations and/or rights consistent with this
 *     License. However, in accepting such obligations, You may act only
 *     on Your own behalf and on Your sole responsibility, not on behalf
 *     of any other Contributor, and only if You agree to indemnify,
 *     defend, and hold each Contributor harmless for any liability
 *     incurred by, or claims asserted against, such Contributor by reason
 *     of your accepting any such warranty or additional liability.
 * 
 * END OF TERMS AND CONDITIONS
 * 
 * APPENDIX: How to apply the Apache License to your work.
 * 
 *       To apply the Apache License to your work, attach the following
 *       boilerplate notice, with the fields enclosed by brackets "[]"
 *       replaced with your own identifying information. (Don't include
 *       the brackets!)  The text should be enclosed in the appropriate
 *       comment syntax for the file format. We also recommend that a
 *       file or class name and description of purpose be included on the
 *       same "printed page" as the copyright notice for easier
 *       identification within third-party archives.
 * 
 * Copyright 2025 OpenAI
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *        http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Keep the upstream policy text intact, including its attribution.
export const localServiceMacOSPlatformPolicy = String.raw`(version 1)

; inspired by Chrome's sandbox policy:
; https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/common.sb;l=273-319;drc=7b3962fe2e5fc9e2ee58000dc8fbf3429d84d3bd
; https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/renderer.sb;l=64;drc=7b3962fe2e5fc9e2ee58000dc8fbf3429d84d3bd

; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))

; process-info
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; sysctls permitted.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  ; Chrome locks these CPU feature detection down a bit more tightly,
  ; but mostly for fingerprinting concerns which isn't an issue for codex.
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  ; Python's ProcessPoolExecutor queries this through sysconf(_SC_SEM_NSEMS_MAX).
  (sysctl-name "kern.sysv.semmns")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable.")
)

; Allow Java to read some CPU info. This is misclassified as a "write" because
; userspace passes a memory buffer to the sysctl, but conceptually it is a read.
(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))

; IOKit
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient")
)

; needed to look up user info, see https://crbug.com/792228
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
)

; Needed for python multiprocessing on MacOS for the SemLock
(allow ipc-posix-sem)

; Needed for PyTorch/libomp on macOS to register OpenMP runtimes.
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))

(allow mach-lookup
  (global-name "com.apple.PowerManagement.control")
)

; allow openpty()
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
; PTYs created before entering seatbelt may lack the extension; allow ioctl
; on those slave ttys so interactive shells detect a TTY and remain functional.
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

; macOS platform defaults included when a split filesystem policy requests \`:minimal\`.

; Read access to standard system paths
(allow file-read* file-test-existence
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/Library/Preferences/Logging")
  (subpath "/private/var/db/DarwinDirectory/local/recordStore.data")
  (subpath "/private/var/db/timezone")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/Library/Preferences")
  (subpath "/var/db")
  (subpath "/private/var/db"))

; Map system frameworks + dylibs for loader.
(allow file-map-executable
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

; System Framework and AppKit resources
(allow file-read* file-test-existence
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

; Allow guarded vnodes.
(allow system-mac-syscall (mac-policy-name "vnguard"))

; Determine whether a container is expected.
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))

; Allow resolution of standard system symlinks.
(allow file-read-metadata file-test-existence
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private/etc/localtime"))

; Allow stat'ing of firmlink parent path components.
(allow file-read-metadata file-test-existence
  (path-ancestors "/System/Volumes/Data/private"))

; Allow processes to get their current working directory.
(allow file-read* file-test-existence
  (literal "/"))

; Allow FSIOC_CAS_BSDFLAGS as alternate chflags.
(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))

; Allow access to standard special files.
(allow file-read* file-test-existence
  (literal "/dev/autofs_nowait")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/private/etc/master.passwd")
  (literal "/private/etc/passwd")
  (literal "/private/etc/protocols")
  (literal "/private/etc/services"))

; Allow null/zero read/write.
(allow file-read* file-test-existence file-write-data
  (literal "/dev/null")
  (literal "/dev/zero"))

; Allow read/write access to the file descriptors.
(allow file-read-data file-test-existence file-write-data
  (subpath "/dev/fd"))

; Provide access to debugger helpers.
(allow file-read* file-test-existence file-write-data file-ioctl
  (literal "/dev/dtracehelper"))

; Allow reading standard config directories.
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/etc"))

(allow file-read* file-test-existence
  (literal "/System/Library/CoreServices")
  (literal "/System/Library/CoreServices/.SystemVersionPlatform.plist")
  (literal "/System/Library/CoreServices/SystemVersion.plist"))

; Some processes read /var metadata during startup.
(allow file-read-metadata (subpath "/var"))
(allow file-read-metadata (subpath "/private/var"))

; IOKit access for root domain services.
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient"))

; macOS Standard library queries opendirectoryd at startup
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))

; Allow IPC to analytics, logging, trust, and other system agents.
(allow mach-lookup
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.analyticsd.messagetracer")
  (global-name "com.apple.appsleep")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.dt.automationmode.reader")
  (global-name "com.apple.espd")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.xpc.activity.unmanaged"))

; Allow IPC to the syslog socket for logging.
(allow network-outbound (literal "/private/var/run/syslog"))

; macOS Notifications
(allow ipc-posix-shm-read*
  (ipc-posix-name "apple.shm.notification_center"))

; Regulatory domain support.
(allow file-read*
  (literal "/private/var/db/eligibilityd/eligibility.plist"))

; Audio and power management services.
(allow mach-lookup (global-name "com.apple.audio.audiohald"))
(allow mach-lookup (global-name "com.apple.audio.AudioComponentRegistrar"))
(allow mach-lookup (global-name "com.apple.PowerManagement.control"))

; Allow reading the minimum system runtime so exec works.
(allow file-read-data (subpath "/bin"))
(allow file-read-metadata (subpath "/bin"))
(allow file-read-data (subpath "/sbin"))
(allow file-read-metadata (subpath "/sbin"))
(allow file-read-data (subpath "/usr/bin"))
(allow file-read-metadata (subpath "/usr/bin"))
(allow file-read-data (subpath "/usr/sbin"))
(allow file-read-metadata (subpath "/usr/sbin"))
(allow file-read-data (subpath "/usr/libexec"))
(allow file-read-metadata (subpath "/usr/libexec"))

(allow file-read* (subpath "/Library/Preferences"))
(allow file-read* (subpath "/opt/homebrew/lib"))
(allow file-read* (subpath "/usr/local/lib"))

; Terminal basics and device handles.
(allow file-read* (regex "^/dev/fd/(0|1|2)$"))
(allow file-write* (regex "^/dev/fd/(1|2)$"))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* file-write* (literal "/dev/tty"))
(allow file-read-metadata (literal "/dev"))
(allow file-read-metadata (regex "^/dev/.*$"))
(allow file-read-metadata (literal "/dev/stdin"))
(allow file-read-metadata (literal "/dev/stdout"))
(allow file-read-metadata (literal "/dev/stderr"))
(allow file-read-metadata (regex "^/dev/tty[^/]*$"))
(allow file-read-metadata (regex "^/dev/pty[^/]*$"))
(allow file-read* file-write* (regex "^/dev/ttys[0-9]+$"))
(allow file-read* file-write* (literal "/dev/ptmx"))
(allow file-ioctl (regex "^/dev/ttys[0-9]+$"))

; Allow metadata traversal for firmlink parents.
(allow file-read-metadata (literal "/System/Volumes") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data/Users") (vnode-type DIRECTORY))

; App sandbox extensions
(allow file-read* (extension "com.apple.app-sandbox.read"))
(allow file-read* file-write* (extension "com.apple.app-sandbox.read-write"))
`;

export const localServiceMacOSNetworkPolicy = String.raw`; when network access is enabled, these policies are added after those in seatbelt_base_policy.sbpl
; proxy-specific allow rules are injected by codex-core based on environment.
; Ref https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/network.sb;drc=f8f264d5e4e7509c913f4c60c2639d15905a07e4

; allow only safe AF_SYSTEM sockets used for local platform services.
(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)
  )
)

(allow mach-lookup
    ; Used by platform helpers that resolve user directory locations.
    (global-name "com.apple.bsd.dirhelper")
    (global-name "com.apple.system.opendirectoryd.membership")

    ; Communicate with the security server for TLS certificate information.
    (global-name "com.apple.SecurityServer")
    (global-name "com.apple.networkd")
    (global-name "com.apple.ocspd")
    (global-name "com.apple.trustd.agent")

    ; Read network configuration.
    (global-name "com.apple.SystemConfiguration.DNSConfiguration")
    (global-name "com.apple.SystemConfiguration.configd")
)

(allow sysctl-read
  (sysctl-name-regex #"^net.routetable")
)
`;

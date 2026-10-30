# Worked examples

Four complete wireframes you can copy and modify. Each one is a valid standalone SVG file. The annotation list under each example is what you should reproduce in your reply when emitting a wireframe.

---

## 1. Login screen (mobile, 375×812)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="375" height="812" viewBox="0 0 375 812"
     font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5">
  <rect x="0" y="0" width="375" height="812" />

  <!-- 1: status bar (placeholder) -->
  <g transform="translate(16, 16)">
    <text x="0" y="14" font-size="12" stroke="none" fill="#666">9:41</text>
    <text x="343" y="14" font-size="12" text-anchor="end" stroke="none" fill="#666">100%</text>
  </g>

  <!-- 2: brand mark -->
  <g transform="translate(159, 120)">
    <rect width="56" height="56" rx="8" fill="#e6e6e6" />
  </g>

  <!-- 3: title -->
  <text x="187" y="216" font-size="28" font-weight="700" text-anchor="middle" stroke="none" fill="#000">Welcome back</text>
  <text x="187" y="248" font-size="14" text-anchor="middle" stroke="none" fill="#666">Sign in to continue</text>

  <!-- 4: email field -->
  <g transform="translate(16, 296)">
    <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Email</text>
    <g transform="translate(0, 24)">
      <rect width="343" height="48" rx="4" />
      <text x="12" y="30" font-size="14" stroke="none" fill="#666">you@example.com</text>
    </g>
  </g>

  <!-- 5: password field -->
  <g transform="translate(16, 400)">
    <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Password</text>
    <g transform="translate(0, 24)">
      <rect width="343" height="48" rx="4" />
      <text x="12" y="30" font-size="14" stroke="none" fill="#666">••••••••</text>
      <text x="331" y="30" font-size="12" text-anchor="end" stroke="none" fill="#666">show</text>
    </g>
    <text x="343" y="92" font-size="12" text-anchor="end" stroke="none" fill="#666">Forgot password?</text>
  </g>

  <!-- 6: primary CTA -->
  <g transform="translate(16, 528)">
    <rect width="343" height="48" rx="4" fill="#000" />
    <text x="171" y="30" font-size="14" font-weight="600" text-anchor="middle" stroke="none" fill="#fff">Sign in</text>
  </g>

  <!-- 7: divider -->
  <g transform="translate(16, 600)">
    <line x1="0" y1="8" x2="140" y2="8" stroke="#666" />
    <text x="171" y="12" font-size="12" text-anchor="middle" stroke="none" fill="#666">or</text>
    <line x1="203" y1="8" x2="343" y2="8" stroke="#666" />
  </g>

  <!-- 8: secondary CTA -->
  <g transform="translate(16, 632)">
    <rect width="343" height="48" rx="4" />
    <text x="171" y="30" font-size="14" text-anchor="middle" stroke="none" fill="#000">Continue with SSO</text>
  </g>

  <!-- 9: footer -->
  <text x="187" y="744" font-size="14" text-anchor="middle" stroke="none" fill="#000">New here? <tspan font-weight="600">Create an account</tspan></text>
</svg>
```

**Annotations:**
1. Status bar placeholder
2. Brand mark
3. Page title + subtitle
4. Email input
5. Password input + reveal control + forgot link
6. Primary CTA (sign in)
7. SSO divider
8. Secondary CTA (SSO)
9. Sign-up link

---

## 2. Admin dashboard (desktop, 1280×800)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"
     font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5">
  <rect x="0" y="0" width="1280" height="800" />

  <!-- 1: sidebar -->
  <g transform="translate(0, 0)" data-region="sidebar">
    <rect width="240" height="800" />
    <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">Acme</text>
    <rect x="0" y="80" width="240" height="40" fill="#e6e6e6" />
    <text x="24" y="105" font-size="14" stroke="none" fill="#000">Dashboard</text>
    <text x="24" y="153" font-size="14" stroke="none" fill="#666">Projects</text>
    <text x="24" y="201" font-size="14" stroke="none" fill="#666">Reports</text>
    <text x="24" y="249" font-size="14" stroke="none" fill="#666">Team</text>
    <text x="24" y="297" font-size="14" stroke="none" fill="#666">Settings</text>
  </g>

  <!-- 2: top bar -->
  <g transform="translate(240, 0)" data-region="topbar">
    <rect width="1040" height="64" />
    <g transform="translate(24, 12)">
      <rect width="400" height="40" rx="20" />
      <circle cx="20" cy="20" r="6" />
      <line x1="24" y1="24" x2="30" y2="30" />
      <text x="40" y="25" font-size="14" stroke="none" fill="#666">Search…</text>
    </g>
    <circle cx="1000" cy="32" r="16" fill="#e6e6e6" />
  </g>

  <!-- 3: page header -->
  <g transform="translate(264, 96)" data-region="header">
    <text x="0" y="28" font-size="28" font-weight="700" stroke="none" fill="#000">Dashboard</text>
    <text x="0" y="56" font-size="14" stroke="none" fill="#666">Overview of activity for the last 7 days</text>
    <g transform="translate(872, 0)">
      <rect width="120" height="40" rx="4" fill="#000" />
      <text x="60" y="25" font-size="14" font-weight="600" text-anchor="middle" stroke="none" fill="#fff">New project</text>
    </g>
  </g>

  <!-- 4: metric tiles -->
  <g transform="translate(264, 184)" data-region="metrics">
    <g transform="translate(0, 0)">
      <rect width="232" height="120" rx="6" />
      <text x="24" y="40" font-size="12" stroke="none" fill="#666">Active users</text>
      <text x="24" y="80" font-size="28" font-weight="700" stroke="none" fill="#000">1,284</text>
      <text x="24" y="104" font-size="12" stroke="none" fill="#666">+12% vs last week</text>
    </g>
    <g transform="translate(256, 0)">
      <rect width="232" height="120" rx="6" />
      <text x="24" y="40" font-size="12" stroke="none" fill="#666">New signups</text>
      <text x="24" y="80" font-size="28" font-weight="700" stroke="none" fill="#000">312</text>
      <text x="24" y="104" font-size="12" stroke="none" fill="#666">+4%</text>
    </g>
    <g transform="translate(512, 0)">
      <rect width="232" height="120" rx="6" />
      <text x="24" y="40" font-size="12" stroke="none" fill="#666">Revenue</text>
      <text x="24" y="80" font-size="28" font-weight="700" stroke="none" fill="#000">$24.1k</text>
      <text x="24" y="104" font-size="12" stroke="none" fill="#666">+8%</text>
    </g>
    <g transform="translate(768, 0)">
      <rect width="232" height="120" rx="6" />
      <text x="24" y="40" font-size="12" stroke="none" fill="#666">Churn</text>
      <text x="24" y="80" font-size="28" font-weight="700" stroke="none" fill="#000">1.4%</text>
      <text x="24" y="104" font-size="12" stroke="none" fill="#666">−0.3%</text>
    </g>
  </g>

  <!-- 5: chart placeholder -->
  <g transform="translate(264, 328)" data-region="chart">
    <rect width="640" height="320" rx="6" />
    <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">Activity</text>
    <rect x="24" y="64" width="592" height="232" fill="#e6e6e6" />
    <line x1="24" y1="64" x2="616" y2="296" stroke="#666" />
    <line x1="616" y1="64" x2="24" y2="296" stroke="#666" />
  </g>

  <!-- 6: recent items list -->
  <g transform="translate(920, 328)" data-region="recent">
    <rect width="336" height="320" rx="6" />
    <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">Recent</text>
    <g transform="translate(0, 64)">
      <line x1="0" y1="0" x2="336" y2="0" stroke="#666" />
      <circle cx="32" cy="28" r="12" fill="#e6e6e6" />
      <text x="56" y="24" font-size="14" font-weight="600" stroke="none" fill="#000">Item one</text>
      <text x="56" y="40" font-size="12" stroke="none" fill="#666">2h ago</text>
    </g>
    <g transform="translate(0, 120)">
      <line x1="0" y1="0" x2="336" y2="0" stroke="#666" />
      <circle cx="32" cy="28" r="12" fill="#e6e6e6" />
      <text x="56" y="24" font-size="14" font-weight="600" stroke="none" fill="#000">Item two</text>
      <text x="56" y="40" font-size="12" stroke="none" fill="#666">5h ago</text>
    </g>
    <g transform="translate(0, 176)">
      <line x1="0" y1="0" x2="336" y2="0" stroke="#666" />
      <circle cx="32" cy="28" r="12" fill="#e6e6e6" />
      <text x="56" y="24" font-size="14" font-weight="600" stroke="none" fill="#000">Item three</text>
      <text x="56" y="40" font-size="12" stroke="none" fill="#666">1d ago</text>
    </g>
  </g>
</svg>
```

**Annotations:**
1. Sidebar nav with active "Dashboard"
2. Top bar with global search and account menu
3. Page header with title, subtitle, and primary CTA
4. Four KPI metric tiles
5. Activity chart panel (chart area shown as placeholder)
6. Recent items list (right rail)

---

## 3. Settings page with form (desktop, 1280×800)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"
     font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5">
  <rect x="0" y="0" width="1280" height="800" />

  <!-- 1: top bar -->
  <g transform="translate(0, 0)">
    <rect width="1280" height="64" />
    <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">Settings</text>
    <circle cx="1240" cy="32" r="16" fill="#e6e6e6" />
  </g>

  <!-- 2: settings nav (left rail) -->
  <g transform="translate(24, 96)">
    <text x="0" y="14" font-size="12" font-weight="600" stroke="none" fill="#666">PERSONAL</text>
    <rect x="-8" y="32" width="216" height="32" fill="#e6e6e6" />
    <text x="0" y="52" font-size="14" stroke="none" fill="#000">Account</text>
    <text x="0" y="84" font-size="14" stroke="none" fill="#666">Notifications</text>
    <text x="0" y="116" font-size="14" stroke="none" fill="#666">Sessions</text>
    <text x="0" y="160" font-size="12" font-weight="600" stroke="none" fill="#666">WORKSPACE</text>
    <text x="0" y="200" font-size="14" stroke="none" fill="#666">Members</text>
    <text x="0" y="232" font-size="14" stroke="none" fill="#666">Billing</text>
    <text x="0" y="264" font-size="14" stroke="none" fill="#666">Integrations</text>
  </g>

  <!-- 3: form content -->
  <g transform="translate(264, 96)">
    <text x="0" y="28" font-size="28" font-weight="700" stroke="none" fill="#000">Account</text>
    <text x="0" y="56" font-size="14" stroke="none" fill="#666">Manage your personal account details.</text>

    <!-- avatar field -->
    <g transform="translate(0, 96)">
      <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Profile photo</text>
      <g transform="translate(0, 24)">
        <circle cx="32" cy="32" r="32" fill="#e6e6e6" />
        <line x1="9" y1="9" x2="55" y2="55" stroke="#666" />
        <line x1="55" y1="9" x2="9" y2="55" stroke="#666" />
      </g>
      <g transform="translate(80, 36)">
        <rect width="120" height="40" rx="4" />
        <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#000">Upload</text>
      </g>
    </g>

    <!-- name field -->
    <g transform="translate(0, 216)">
      <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Display name</text>
      <g transform="translate(0, 24)">
        <rect width="480" height="40" rx="4" />
        <text x="12" y="25" font-size="14" stroke="none" fill="#000">Alex Morgan</text>
      </g>
    </g>

    <!-- email field -->
    <g transform="translate(0, 312)">
      <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Email</text>
      <g transform="translate(0, 24)">
        <rect width="480" height="40" rx="4" />
        <text x="12" y="25" font-size="14" stroke="none" fill="#000">alex@acme.com</text>
      </g>
      <text x="0" y="84" font-size="12" stroke="none" fill="#666">Used for sign-in and notifications.</text>
    </g>

    <!-- role dropdown -->
    <g transform="translate(0, 432)">
      <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Role</text>
      <g transform="translate(0, 24)">
        <rect width="200" height="40" rx="4" />
        <text x="12" y="25" font-size="14" stroke="none" fill="#000">Admin</text>
        <polyline points="180,17 188,25 180,33" fill="none" />
      </g>
    </g>

    <!-- footer actions -->
    <g transform="translate(0, 552)">
      <line x1="0" y1="0" x2="800" y2="0" stroke="#666" />
      <g transform="translate(560, 24)">
        <rect width="120" height="40" rx="4" />
        <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#000">Cancel</text>
      </g>
      <g transform="translate(688, 24)">
        <rect width="112" height="40" rx="4" fill="#000" />
        <text x="56" y="25" font-size="14" font-weight="600" text-anchor="middle" stroke="none" fill="#fff">Save</text>
      </g>
    </g>
  </g>
</svg>
```

**Annotations:**
1. Top bar with section name
2. Settings sub-nav (Personal / Workspace groups)
3. Form: avatar with upload, display name, email + help text, role dropdown, save / cancel actions

---

## 4. Modal confirmation overlay (desktop, 1280×800)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"
     font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5">
  <rect x="0" y="0" width="1280" height="800" />

  <!-- underlying screen (faded) -->
  <g transform="translate(0,0)" opacity="0.5">
    <rect width="1280" height="64" />
    <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">Projects</text>
  </g>

  <!-- 1: backdrop -->
  <rect x="0" y="0" width="1280" height="800" fill="#000" fill-opacity="0.4" stroke="none" />

  <!-- 2: modal -->
  <g transform="translate(320, 240)" data-region="modal">
    <rect width="640" height="320" rx="6" />
    <text x="24" y="48" font-size="20" font-weight="600" stroke="none" fill="#000">Delete project?</text>
    <line x1="0" y1="72" x2="640" y2="72" />

    <text x="24" y="112" font-size="14" stroke="none" fill="#000">This permanently deletes the project and all its data.</text>
    <text x="24" y="136" font-size="14" stroke="none" fill="#000">This action can't be undone.</text>

    <!-- confirm input -->
    <g transform="translate(24, 168)">
      <text x="0" y="14" font-size="12" stroke="none" fill="#666">Type the project name to confirm</text>
      <g transform="translate(0, 24)">
        <rect width="592" height="40" rx="4" />
        <text x="12" y="25" font-size="14" stroke="none" fill="#666">acme-prod</text>
      </g>
    </g>

    <!-- footer -->
    <line x1="0" y1="248" x2="640" y2="248" />
    <g transform="translate(384, 268)">
      <rect width="120" height="40" rx="4" />
      <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#000">Cancel</text>
    </g>
    <g transform="translate(512, 268)">
      <rect width="104" height="40" rx="4" fill="#000" />
      <text x="52" y="25" font-size="14" font-weight="600" text-anchor="middle" stroke="none" fill="#fff">Delete</text>
    </g>
  </g>

  <!-- 3: annotation -->
  <g data-region="annotations">
    <circle cx="976" cy="556" r="12" fill="#fff" stroke="#d33" stroke-dasharray="4 2" />
    <text x="976" y="560" font-size="12" font-weight="700" text-anchor="middle" stroke="none" fill="#d33">1</text>
    <text x="996" y="564" font-size="12" stroke="none" fill="#d33">Disable until input matches project name</text>
  </g>
</svg>
```

**Annotations:**
1. Backdrop dims the underlying page
2. Confirmation modal: title, body copy, type-to-confirm field, Cancel + destructive Confirm
3. Reviewer note (red dashed): the destructive button must remain disabled until the typed input matches

---

## Multi-screen flow

When emitting a flow, render each screen as its own `<g transform="translate(x,0)">` inside one SVG, separated by 80px gutters and connected with arrow primitives from `components.md`. Or emit one SVG per screen and a `flow.svg` summary that arranges thumbnails (scaled with `transform="scale(0.25)"`) left-to-right. Either is acceptable; pick whichever the reviewer can scan faster.

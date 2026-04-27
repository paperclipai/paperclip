import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ── Package definitions ────────────────────────────────────────────────────

const PACKAGES = [
  {
    id: "starter",
    name: "Starter",
    tagline: "Refresh & Tidy",
    price: "$4,500 – $6,500",
    deposit: "$1,200",
    timeline: "3–5 days",
    color: "bg-emerald-50 border-emerald-200",
    badge: "Most Popular",
    badgeColor: "bg-emerald-100 text-emerald-800",
    features: [
      "Lawn aeration + overseeding",
      "Mulch refresh (2 cu yd)",
      "2 accent shrubs / ornamental grasses",
      "Edge definition along driveway + beds",
      "Spring / fall cleanup visit included",
    ],
    afterImage: "/yard-demo/depth_preview.jpg",
  },
  {
    id: "standard",
    name: "Standard",
    tagline: "Transform & Enjoy",
    price: "$9,000 – $13,500",
    deposit: "$2,800",
    timeline: "7–10 days",
    color: "bg-blue-50 border-blue-200",
    badge: "",
    badgeColor: "",
    features: [
      "Everything in Starter",
      "New curved planting beds (120 sq ft)",
      "Flagstone stepping-path (20 ft)",
      "Seasonal color rotation (3×/year)",
      "Low-voltage landscape lighting (6 fixtures)",
      "Irrigation zone tie-in for new beds",
    ],
    afterImage: "/yard-demo/depth_preview.jpg",
  },
  {
    id: "premium",
    name: "Premium",
    tagline: "Full Transformation",
    price: "$19,000 – $26,000",
    deposit: "$5,500",
    timeline: "2–3 weeks",
    color: "bg-purple-50 border-purple-200",
    badge: "Best Value",
    badgeColor: "bg-purple-100 text-purple-800",
    features: [
      "Everything in Standard",
      "Poured-concrete or paver patio expansion",
      "Pergola or shade sail structure",
      "Raised garden beds (cedar, 2×)",
      "Full drip irrigation system",
      "Privacy hedge row (6–8 ft mature)",
      "Outdoor outlet + accent wall",
      "1-year maintenance plan included",
    ],
    afterImage: "/yard-demo/depth_preview.jpg",
  },
];

// ── 3D Point Cloud Viewer ──────────────────────────────────────────────────

function PointCloudViewer({ glbUrl }: { glbUrl: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const w = el.clientWidth;
    const h = el.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);

    const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
    camera.position.set(0, 5, 15);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;

    // Grid
    const grid = new THREE.GridHelper(40, 20, 0x333333, 0x222222);
    scene.add(grid);

    // Ambient light
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    // Load GLB
    const loader = new GLTFLoader();
    loader.load(
      glbUrl,
      (gltf) => {
        const group = gltf.scene;
        // The scan uses a Z-up coordinate system (pavement is a flat plane at
        // constant Z, vegetation is above it). Three.js is Y-up. Rotate +90°
        // around X to convert Z-up → Y-up before computing the bounding box.
        group.rotation.x = Math.PI / 2;
        group.updateMatrixWorld(true);
        const box = new THREE.Box3();
        group.traverse((child) => {
          if (child instanceof THREE.Points) {
            const mat = child.material as THREE.PointsMaterial;
            mat.size = 0.25;
            mat.sizeAttenuation = true;
            mat.vertexColors = true;
            box.union(new THREE.Box3().setFromObject(child));
          } else if (
            child instanceof THREE.Mesh ||
            child instanceof THREE.Camera ||
            child instanceof THREE.Light ||
            child instanceof THREE.Line
          ) {
            child.visible = false;
          }
        });
        if (box.isEmpty()) box.setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 10 / maxDim;
        // Save Y_min before center is mutated by multiplyScalar below
        const yGroundScaled = (box.min.y - center.y) * scale;
        group.position.sub(center.multiplyScalar(scale));
        group.scale.setScalar(scale);
        scene.add(group);
        // Drop the grid to the actual ground (pavement) level
        grid.position.y = yGroundScaled;
        // Ground-level human view: eye height above yard floor, close in
        // Eye just above the main yard surface (world Y≈+1.7), looking across.
        camera.fov = 70;
        camera.updateProjectionMatrix();
        camera.position.set(0, 2.3, 5.5);
        controls.target.set(0, 1.5, 0);
        controls.autoRotateSpeed = 0.25;
        controls.update();
        setLoading(false);
      },
      undefined,
      (err) => {
        console.error(err);
        setError("Could not load 3D model");
        setLoading(false);
      }
    );

    // Keyboard fly controls — WASD/arrows move, Q/E up/down, R reset
    const initPos = new THREE.Vector3(0, 2.3, 5.5);
    const initTarget = new THREE.Vector3(0, 1.5, 0);
    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      keys.add(e.code);
      controls.autoRotate = false;
      if (e.code === "KeyR") {
        camera.position.copy(initPos);
        controls.target.copy(initTarget);
        controls.update();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      if (keys.size > 0) {
        const dist = Math.max(camera.position.distanceTo(controls.target), 0.5);
        const speed = dist * 0.025;
        const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();
        const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
        const move = new THREE.Vector3();
        if (keys.has("KeyW") || keys.has("ArrowUp"))    move.addScaledVector(fwd, speed);
        if (keys.has("KeyS") || keys.has("ArrowDown"))  move.addScaledVector(fwd, -speed);
        if (keys.has("KeyA") || keys.has("ArrowLeft"))  move.addScaledVector(right, -speed);
        if (keys.has("KeyD") || keys.has("ArrowRight")) move.addScaledVector(right, speed);
        if (keys.has("KeyQ"))                            move.y += speed;
        if (keys.has("KeyE"))                            move.y -= speed;
        camera.position.add(move);
        controls.target.add(move);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      if (!el) return;
      const w2 = el.clientWidth;
      const h2 = el.clientHeight;
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      controls.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, [glbUrl]);

  return (
    <div className="relative w-full h-full">
      <div ref={mountRef} className="w-full h-full rounded-lg overflow-hidden" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]/80 rounded-lg">
          <div className="text-center text-white">
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-2" />
            <p className="text-sm text-white/70">Loading 3D scan…</p>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]/80 rounded-lg">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}
      {!loading && !error && (
        <div className="absolute bottom-2 left-3 text-[11px] text-white/35 select-none pointer-events-none">
          WASD / ↑↓←→ move · Q/E up/down · drag to rotate · scroll to zoom · R reset
        </div>
      )}
    </div>
  );
}

// ── Package Card ───────────────────────────────────────────────────────────

function PackageCard({
  pkg,
  selected,
  onSelect,
}: {
  pkg: (typeof PACKAGES)[0];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`relative border-2 rounded-xl p-5 cursor-pointer transition-all select-none
        ${selected ? "border-blue-500 shadow-lg shadow-blue-500/20" : `border-gray-200 hover:border-gray-300 ${pkg.color}`}
      `}
    >
      {pkg.badge && (
        <span
          className={`absolute -top-3 left-4 text-xs font-semibold px-2 py-0.5 rounded-full ${pkg.badgeColor}`}
        >
          {pkg.badge}
        </span>
      )}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900">{pkg.name}</h3>
          <p className="text-sm text-gray-500">{pkg.tagline}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-gray-900">{pkg.price}</p>
          <p className="text-xs text-gray-500">{pkg.timeline}</p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {pkg.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
            <svg
              className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            {f}
          </li>
        ))}
      </ul>
      {selected && (
        <div className="mt-4 pt-3 border-t border-blue-200">
          <p className="text-xs text-blue-600 font-medium">
            Deposit to lock in: {pkg.deposit}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export function YardProposalDemo() {
  const [view, setView] = useState<"before" | "3d" | "after">("before");
  const [selectedPkg, setSelectedPkg] = useState("starter");
  const [approved, setApproved] = useState(false);
  const [approving, setApproving] = useState(false);

  const pkg = PACKAGES.find((p) => p.id === selectedPkg)!;

  function handleApprove() {
    setApproving(true);
    setTimeout(() => {
      setApproving(false);
      setApproved(true);
    }, 1400);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            </div>
            <div>
              <h1 className="font-semibold text-gray-900 text-sm">3D Yard Proposals</h1>
              <p className="text-xs text-gray-500">123 Maple Street · Sarah & Tom Johnson</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-200 bg-emerald-50">
              AI-Generated
            </Badge>
            <span className="text-xs text-gray-400">Powered by LingBot-Map</span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* View toggle + 3D / Before preview */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Viewer panel */}
          <div className="lg:col-span-3">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Toggle tabs */}
              <div className="flex border-b border-gray-200">
                {(["before", "3d", "after"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                      view === v
                        ? "text-blue-600 border-b-2 border-blue-500 bg-blue-50/50"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {v === "before" ? "Before" : v === "3d" ? "3D Scan" : "After Preview"}
                  </button>
                ))}
              </div>

              {/* View content */}
              <div className="aspect-video bg-gray-900">
                {view === "before" && (
                  <img
                    src="/yard-demo/before_01.png"
                    alt="Before"
                    className="w-full h-full object-cover"
                  />
                )}
                {view === "3d" && (
                  <PointCloudViewer glbUrl="/yard-demo/yard_reconstruction_lite.glb" />
                )}
                {view === "after" && (
                  <div className="w-full h-full relative">
                    <img
                      src="/yard-demo/depth_preview.jpg"
                      alt="Depth analysis"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-4">
                      <div className="text-white">
                        <p className="text-sm font-semibold">{pkg.name} Package Preview</p>
                        <p className="text-xs text-white/70">{pkg.tagline} · {pkg.price}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Scan stats bar */}
              <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex items-center gap-6 text-xs text-gray-500">
                <span>📐 22.8 × 14.4 × 6.2 m</span>
                <span>☁️ 7.6M points</span>
                <span>✓ 65% high-confidence</span>
                <span className="ml-auto text-emerald-600 font-medium">Scan complete</span>
              </div>
            </div>
          </div>

          {/* Info + CTA */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Your Property</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Scan date</span>
                  <span className="font-medium">April 26, 2026</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Yard area</span>
                  <span className="font-medium">~5,200 sq ft</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Condition</span>
                  <span className="font-medium text-amber-600">Fair — maintenance needed</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Designer</span>
                  <span className="font-medium">Carlos Medina, APLD</span>
                </div>
              </CardContent>
            </Card>

            {!approved ? (
              <Card className="border-blue-200 bg-blue-50/30">
                <CardContent className="pt-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-900">
                    Selected: <span className="text-blue-600">{pkg.name} Package</span>
                  </p>
                  <p className="text-2xl font-bold text-gray-900">{pkg.price}</p>
                  <p className="text-xs text-gray-500">
                    Lock in with {pkg.deposit} deposit · {pkg.timeline} to complete
                  </p>
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={handleApprove}
                    disabled={approving}
                  >
                    {approving ? (
                      <span className="flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Sending approval…
                      </span>
                    ) : (
                      "Approve & Get Quote"
                    )}
                  </Button>
                  <p className="text-xs text-center text-gray-400">
                    No commitment — Carlos will follow up within 24h
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-emerald-300 bg-emerald-50">
                <CardContent className="pt-4 text-center space-y-2">
                  <div className="w-10 h-10 bg-emerald-500 rounded-full flex items-center justify-center mx-auto">
                    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="font-semibold text-emerald-800">Proposal Approved!</p>
                  <p className="text-sm text-emerald-700">
                    Carlos will contact you within 24 hours to confirm the {pkg.name} package and next steps.
                  </p>
                  <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">
                    {pkg.name} · {pkg.price}
                  </Badge>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Package selector */}
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Choose Your Package</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {PACKAGES.map((p) => (
              <PackageCard
                key={p.id}
                pkg={p}
                selected={selectedPkg === p.id}
                onSelect={() => setSelectedPkg(p.id)}
              />
            ))}
          </div>
        </div>

        {/* How it works */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">How 3D Yard Proposals Work</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { step: "1", icon: "📱", title: "Record video", desc: "Walk around your yard with your phone" },
                { step: "2", icon: "☁️", title: "AI processes", desc: "LingBot-Map builds a 3D point cloud in ~30s" },
                { step: "3", icon: "🌿", title: "Designer layers", desc: "Your designer places plants, paths & features" },
                { step: "4", icon: "✅", title: "Review & approve", desc: "See before/after, pick a package, approve" },
              ].map((item) => (
                <div key={item.step} className="text-center">
                  <div className="text-2xl mb-1">{item.icon}</div>
                  <p className="text-sm font-semibold text-gray-900">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Tech note */}
        <div className="text-xs text-gray-400 text-center pb-4">
          3D reconstruction powered by{" "}
          <a
            href="https://github.com/Robbyant/lingbot-map"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-600"
          >
            LingBot-Map
          </a>{" "}
          (Geometric Context Transformer) · RTX 4070 Ti SUPER · 1080p60 drone capture · 7.6M points
        </div>
      </div>
    </div>
  );
}

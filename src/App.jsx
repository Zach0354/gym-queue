import { useState, useEffect, useRef, useCallback } from "react";

const QR_SIZE = 256;

const drawQR = (canvas, text, size = QR_SIZE) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width = size;
  canvas.height = size;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  const mc = 21, cs = size / mc;
  const bytes = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
  ctx.fillStyle = "#000";
  const drawFinder = (x, y) => {
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 7; c++) {
        if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
          ctx.fillRect((x + c) * cs, (y + r) * cs, cs, cs);
      }
  };
  drawFinder(0, 0); drawFinder(mc - 7, 0); drawFinder(0, mc - 7);
  for (let i = 8; i < mc - 8; i++) if (i % 2 === 0) {
    ctx.fillRect(i * cs, 6 * cs, cs, cs);
    ctx.fillRect(6 * cs, i * cs, cs, cs);
  }
  let bi = 0;
  const bits = [];
  const lb = [];
  for (let bit = 7; bit >= 0; bit--) lb.push((text.length >> bit) & 1);
  for (const b of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((b >> bit) & 1);
  const db = [...lb, ...bits];
  for (let col = mc - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5;
    for (let row = 0; row < mc; row++)
      for (let c = 0; c < 2; c++) {
        const x = col - c, y = row;
        if (x < 8 && y < 8) continue;
        if (x >= mc - 7 && y < 8) continue;
        if (x < 8 && y >= mc - 7) continue;
        if (x === 6 || y === 6) continue;
        if (bi < db.length && db[bi]) ctx.fillRect(x * cs, y * cs, cs, cs);
        bi++;
      }
  }
};

const EQUIPMENT = [
  { id: "bench-press", name: "Bench Press", icon: "🏋️", timeLimitMin: 10 },
  { id: "squat-rack", name: "Squat Rack", icon: "🦵", timeLimitMin: 10 },
  { id: "deadlift-platform", name: "Deadlift Platform", icon: "💪", timeLimitMin: 8 },
  { id: "cable-machine", name: "Cable Machine", icon: "🔗", timeLimitMin: 7 },
  { id: "leg-press", name: "Leg Press", icon: "🦿", timeLimitMin: 8 },
  { id: "pull-up-bar", name: "Pull-Up Bar", icon: "🤸", timeLimitMin: 5 },
  { id: "rowing-machine", name: "Rowing Machine", icon: "🚣", timeLimitMin: 10 },
  { id: "treadmill", name: "Treadmill", icon: "🏃", timeLimitMin: 10 },
];

const VIEWS = { AUTH: "auth", HOME: "home", ADMIN: "admin", JOIN: "join", QR: "qr", PROFILE: "profile" };
const CLAIM_TIMEOUT = 120;

export default function App() {
  const [view, setView] = useState(VIEWS.AUTH);
  const [authMode, setAuthMode] = useState("login");
  const [accounts, setAccounts] = useState([
    { username: "admin", password: "admin123", displayName: "Admin", role: "admin" },
  ]);
  const [currentUser, setCurrentUser] = useState(null);
  const [authForm, setAuthForm] = useState({ username: "", password: "", displayName: "" });
  const [authError, setAuthError] = useState("");

  const [queues, setQueues] = useState(() => {
    const init = {};
    EQUIPMENT.forEach(e => (init[e.id] = []));
    return init;
  });
  const [selectedEquipment, setSelectedEquipment] = useState(null);
  const [joinEquipmentId, setJoinEquipmentId] = useState(null);
  const [scanInput, setScanInput] = useState("");
  const [toast, setToast] = useState(null);
  const qrCanvasRef = useRef(null);

  // Active sessions: { [equipId]: { userId, username, displayName, startedAt, expiresAt } }
  const [activeSessions, setActiveSessions] = useState({});
  // Pending claims: { [equipId]: { userId, username, displayName, claimExpiresAt } }
  const [pendingClaims, setPendingClaims] = useState({});

  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setTick(n => n + 1);
      // Check expired claims
      setPendingClaims(prev => {
        const now = Date.now();
        const next = { ...prev };
        let changed = false;
        for (const eqId of Object.keys(next)) {
          if (next[eqId] && now >= next[eqId].claimExpiresAt) {
            delete next[eqId];
            changed = true;
            // Move to next person
            promoteNext(eqId);
          }
        }
        return changed ? next : prev;
      });
      // Check expired active sessions
      setActiveSessions(prev => {
        const now = Date.now();
        const next = { ...prev };
        let changed = false;
        for (const eqId of Object.keys(next)) {
          if (next[eqId] && now >= next[eqId].expiresAt) {
            delete next[eqId];
            changed = true;
            promoteNextFromActive(eqId);
          }
        }
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(t);
  }, [queues]);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const promoteNext = useCallback((eqId) => {
    setQueues(prev => {
      const q = prev[eqId] || [];
      if (q.length === 0) return prev;
      // Remove first (they missed their claim), promote second
      const remaining = q.slice(1);
      if (remaining.length > 0) {
        const nextUser = remaining[0];
        setPendingClaims(pc => ({
          ...pc,
          [eqId]: {
            userId: nextUser.userId,
            username: nextUser.username,
            displayName: nextUser.displayName,
            claimExpiresAt: Date.now() + CLAIM_TIMEOUT * 1000,
          },
        }));
      }
      return { ...prev, [eqId]: remaining };
    });
  }, []);

  const promoteNextFromActive = useCallback((eqId) => {
    setQueues(prev => {
      const q = prev[eqId] || [];
      if (q.length > 0) {
        const nextUser = q[0];
        setPendingClaims(pc => ({
          ...pc,
          [eqId]: {
            userId: nextUser.userId,
            username: nextUser.username,
            displayName: nextUser.displayName,
            claimExpiresAt: Date.now() + CLAIM_TIMEOUT * 1000,
          },
        }));
      }
      return prev;
    });
  }, []);

  const addToQueue = useCallback((equipId) => {
    if (!currentUser) return;
    setQueues(prev => {
      if (prev[equipId]?.some(u => u.userId === currentUser.username)) {
        showToast("You're already in this queue!", "error");
        return prev;
      }
      const eq = EQUIPMENT.find(e => e.id === equipId);
      const newEntry = {
        userId: currentUser.username,
        username: currentUser.username,
        displayName: currentUser.displayName,
        joinedAt: Date.now(),
      };
      const newQ = [...(prev[equipId] || []), newEntry];

      // If queue was empty and no active session and no pending claim, immediately create a claim
      if (newQ.length === 1 && !activeSessions[equipId] && !pendingClaims[equipId]) {
        setPendingClaims(pc => ({
          ...pc,
          [equipId]: {
            userId: newEntry.userId,
            username: newEntry.username,
            displayName: newEntry.displayName,
            claimExpiresAt: Date.now() + CLAIM_TIMEOUT * 1000,
          },
        }));
      }

      showToast(`Added to ${eq?.name} queue! Position: #${newQ.length}`);
      return { ...prev, [equipId]: newQ };
    });
  }, [currentUser, activeSessions, pendingClaims]);

  const leaveQueue = (equipId) => {
    if (!currentUser) return;
    setQueues(prev => {
      const q = prev[equipId] || [];
      const idx = q.findIndex(u => u.userId === currentUser.username);
      if (idx === -1) return prev;
      const newQ = q.filter((_, i) => i !== idx);
      // If first in queue had a pending claim, clear it and promote next
      if (idx === 0 && pendingClaims[equipId]?.userId === currentUser.username) {
        setPendingClaims(pc => {
          const n = { ...pc };
          delete n[equipId];
          return n;
        });
        if (newQ.length > 0) {
          const next = newQ[0];
          setPendingClaims(pc => ({
            ...pc,
            [equipId]: {
              userId: next.userId, username: next.username, displayName: next.displayName,
              claimExpiresAt: Date.now() + CLAIM_TIMEOUT * 1000,
            },
          }));
        }
      }
      return { ...prev, [equipId]: newQ };
    });
    showToast("Left the queue");
  };

  const claimTurn = (equipId) => {
    if (!currentUser) return;
    const claim = pendingClaims[equipId];
    if (!claim || claim.userId !== currentUser.username) return;
    const eq = EQUIPMENT.find(e => e.id === equipId);
    setActiveSessions(prev => ({
      ...prev,
      [equipId]: {
        userId: currentUser.username,
        username: currentUser.username,
        displayName: currentUser.displayName,
        startedAt: Date.now(),
        expiresAt: Date.now() + eq.timeLimitMin * 60 * 1000,
      },
    }));
    setPendingClaims(prev => {
      const n = { ...prev };
      delete n[equipId];
      return n;
    });
    // Remove from queue
    setQueues(prev => ({
      ...prev,
      [equipId]: (prev[equipId] || []).filter(u => u.userId !== currentUser.username),
    }));
    showToast(`Started your session on ${eq.name}! You have ${eq.timeLimitMin} minutes.`);
  };

  const endSession = (equipId) => {
    if (!currentUser) return;
    const session = activeSessions[equipId];
    if (!session || session.userId !== currentUser.username) return;
    setActiveSessions(prev => {
      const n = { ...prev };
      delete n[equipId];
      return n;
    });
    showToast("Session ended! Equipment is now available.");
    // Promote next
    const q = queues[equipId] || [];
    if (q.length > 0) {
      const next = q[0];
      setPendingClaims(pc => ({
        ...pc,
        [equipId]: {
          userId: next.userId, username: next.username, displayName: next.displayName,
          claimExpiresAt: Date.now() + CLAIM_TIMEOUT * 1000,
        },
      }));
    }
  };

  // Auth
  const handleAuth = () => {
    setAuthError("");
    const { username, password, displayName } = authForm;
    if (!username.trim() || !password.trim()) { setAuthError("All fields required"); return; }
    if (authMode === "register") {
      if (!displayName.trim()) { setAuthError("Display name required"); return; }
      if (accounts.find(a => a.username.toLowerCase() === username.trim().toLowerCase())) {
        setAuthError("Username already taken"); return;
      }
      if (password.length < 4) { setAuthError("Password must be 4+ characters"); return; }
      const newAcc = { username: username.trim().toLowerCase(), password, displayName: displayName.trim(), role: "user" };
      setAccounts(prev => [...prev, newAcc]);
      setCurrentUser(newAcc);
      setView(VIEWS.HOME);
      showToast(`Welcome, ${newAcc.displayName}!`);
    } else {
      const acc = accounts.find(a => a.username.toLowerCase() === username.trim().toLowerCase() && a.password === password);
      if (!acc) { setAuthError("Invalid username or password"); return; }
      setCurrentUser(acc);
      setView(VIEWS.HOME);
      showToast(`Welcome back, ${acc.displayName}!`);
    }
    setAuthForm({ username: "", password: "", displayName: "" });
  };

  const logout = () => {
    setCurrentUser(null);
    setView(VIEWS.AUTH);
    setAuthForm({ username: "", password: "", displayName: "" });
  };

  const handleScanSubmit = () => {
    const trimmed = scanInput.trim();
    if (trimmed.startsWith("GYMQ:")) {
      const eqId = trimmed.replace("GYMQ:", "");
      if (EQUIPMENT.find(e => e.id === eqId)) {
        setJoinEquipmentId(eqId);
        setView(VIEWS.JOIN);
        setScanInput("");
        return;
      }
    }
    showToast("Invalid QR code data.", "error");
  };

  useEffect(() => {
    if (view === VIEWS.QR && selectedEquipment && qrCanvasRef.current) {
      drawQR(qrCanvasRef.current, `GYMQ:${selectedEquipment}`, QR_SIZE);
    }
  }, [view, selectedEquipment]);

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const fmtAgo = (ts) => {
    const diff = Math.floor((Date.now() - ts) / 60000);
    return diff < 1 ? "just now" : `${diff}m ago`;
  };

  const isAdmin = currentUser?.role === "admin";

  const getUserStatus = (equipId) => {
    if (!currentUser) return null;
    const session = activeSessions[equipId];
    if (session?.userId === currentUser.username) return "active";
    const claim = pendingClaims[equipId];
    if (claim?.userId === currentUser.username) return "claim";
    const q = queues[equipId] || [];
    const pos = q.findIndex(u => u.userId === currentUser.username);
    if (pos >= 0) return `queued-${pos}`;
    return null;
  };

  // AUTH VIEW
  if (view === VIEWS.AUTH) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-5xl mb-3">🏋️</div>
            <h1 className="text-3xl font-bold">GymQueue</h1>
            <p className="text-gray-400 text-sm mt-1">Skip the wait, join the queue</p>
          </div>
          <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 space-y-4">
            <div className="flex bg-gray-800 rounded-xl p-1">
              <button onClick={() => { setAuthMode("login"); setAuthError(""); }} className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${authMode === "login" ? "bg-blue-600" : ""}`}>Log In</button>
              <button onClick={() => { setAuthMode("register"); setAuthError(""); }} className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${authMode === "register" ? "bg-blue-600" : ""}`}>Sign Up</button>
            </div>
            {authMode === "register" && (
              <input value={authForm.displayName} onChange={e => setAuthForm(p => ({ ...p, displayName: e.target.value }))}
                placeholder="Display Name" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500" />
            )}
            <input value={authForm.username} onChange={e => setAuthForm(p => ({ ...p, username: e.target.value }))}
              placeholder="Username" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
              onKeyDown={e => e.key === "Enter" && handleAuth()} />
            <input value={authForm.password} onChange={e => setAuthForm(p => ({ ...p, password: e.target.value }))}
              type="password" placeholder="Password" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
              onKeyDown={e => e.key === "Enter" && handleAuth()} />
            {authError && <p className="text-red-400 text-xs">{authError}</p>}
            <button onClick={handleAuth} className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition">
              {authMode === "login" ? "Log In" : "Create Account"}
            </button>
            {authMode === "login" && (
              <p className="text-xs text-gray-500 text-center">Admin: admin / admin123</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-2xl text-sm font-medium ${toast.type === "error" ? "bg-red-600" : "bg-emerald-600"}`}>
          {toast.msg}
        </div>
      )}

      <header className="bg-gray-900 border-b border-gray-800 sticky top-0 z-40">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <button onClick={() => setView(VIEWS.HOME)} className="flex items-center gap-2">
            <span className="text-2xl">🏋️</span>
            <span className="font-bold text-lg">GymQueue</span>
          </button>
          <div className="flex items-center gap-2">
            <button onClick={() => setView(VIEWS.HOME)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${view === VIEWS.HOME || view === VIEWS.JOIN ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}>
              Equipment
            </button>
            {isAdmin && (
              <button onClick={() => setView(VIEWS.ADMIN)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${view === VIEWS.ADMIN || view === VIEWS.QR ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}>
                Admin
              </button>
            )}
            <button onClick={() => setView(VIEWS.PROFILE)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${view === VIEWS.PROFILE ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center text-xs font-bold">
                  {currentUser.displayName[0].toUpperCase()}
                </span>
                <span className="hidden sm:inline">{currentUser.displayName}</span>
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">

        {/* PROFILE */}
        {view === VIEWS.PROFILE && (
          <div className="space-y-5">
            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 text-center">
              <div className="w-16 h-16 rounded-full bg-indigo-500 flex items-center justify-center text-2xl font-bold mx-auto mb-3">
                {currentUser.displayName[0].toUpperCase()}
              </div>
              <h1 className="text-xl font-bold">{currentUser.displayName}</h1>
              <p className="text-gray-400 text-sm">@{currentUser.username}</p>
              {isAdmin && <span className="inline-block mt-2 bg-yellow-600 text-xs font-semibold px-3 py-1 rounded-full">ADMIN</span>}
            </div>

            {/* My active sessions / queues */}
            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-5">
              <h2 className="font-semibold mb-3 text-sm text-gray-300 uppercase tracking-wide">My Activity</h2>
              {(() => {
                const items = [];
                EQUIPMENT.forEach(eq => {
                  const st = getUserStatus(eq.id);
                  if (st === "active") items.push({ eq, label: "Using now", color: "text-green-400" });
                  else if (st === "claim") items.push({ eq, label: "Your turn! Claim it", color: "text-yellow-400" });
                  else if (st?.startsWith("queued-")) items.push({ eq, label: `#${parseInt(st.split("-")[1]) + 1} in queue`, color: "text-blue-400" });
                });
                if (items.length === 0) return <p className="text-sm text-gray-500">You're not in any queues</p>;
                return items.map(({ eq, label, color }) => (
                  <div key={eq.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{eq.icon}</span>
                      <div>
                        <p className="text-sm font-medium">{eq.name}</p>
                        <p className={`text-xs ${color}`}>{label}</p>
                      </div>
                    </div>
                    <button onClick={() => { setJoinEquipmentId(eq.id); setView(VIEWS.JOIN); }}
                      className="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition">View</button>
                  </div>
                ));
              })()}
            </div>

            <button onClick={logout} className="w-full bg-red-800 hover:bg-red-700 py-3 rounded-xl font-medium transition">
              Log Out
            </button>
          </div>
        )}

        {/* HOME */}
        {view === VIEWS.HOME && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold">Equipment</h1>
              <p className="text-gray-400 text-sm">Scan a QR code or tap to join a queue</p>
            </div>

            <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
              <h2 className="font-semibold mb-3 text-sm text-gray-300 uppercase tracking-wide">📷 Scan QR Code</h2>
              <div className="flex gap-2">
                <input value={scanInput} onChange={e => setScanInput(e.target.value)}
                  placeholder="Paste scanned QR data (e.g. GYMQ:bench-press)"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  onKeyDown={e => e.key === "Enter" && handleScanSubmit()} />
                <button onClick={handleScanSubmit} className="bg-blue-600 hover:bg-blue-500 px-5 py-2.5 rounded-xl text-sm font-medium transition">Go</button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {EQUIPMENT.map(eq => {
                const qLen = queues[eq.id]?.length || 0;
                const session = activeSessions[eq.id];
                const claim = pendingClaims[eq.id];
                const st = getUserStatus(eq.id);
                const isYourTurn = st === "claim";
                return (
                  <button key={eq.id}
                    onClick={() => { setJoinEquipmentId(eq.id); setView(VIEWS.JOIN); }}
                    className={`bg-gray-900 border rounded-2xl p-4 text-left transition ${isYourTurn ? "border-yellow-500 ring-1 ring-yellow-500/30" : "border-gray-800 hover:border-blue-500"}`}>
                    <div className="text-2xl mb-2">{eq.icon}</div>
                    <div className="font-semibold text-sm">{eq.name}</div>
                    <div className="text-xs mt-1">
                      {session ? (
                        <span className="text-green-400">● In use{session.userId === currentUser?.username ? " (you)" : ""}</span>
                      ) : claim ? (
                        <span className="text-yellow-400">● Waiting to be claimed{isYourTurn ? " — YOUR TURN!" : ""}</span>
                      ) : (
                        <span className="text-gray-500">● Available</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{qLen} in queue • {eq.timeLimitMin}min limit</div>
                    {st?.startsWith("queued-") && <div className="text-xs text-blue-400 mt-1">You're #{parseInt(st.split("-")[1]) + 1}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* JOIN / EQUIPMENT DETAIL */}
        {view === VIEWS.JOIN && joinEquipmentId && (() => {
          const eq = EQUIPMENT.find(e => e.id === joinEquipmentId);
          const q = queues[joinEquipmentId] || [];
          const session = activeSessions[joinEquipmentId];
          const claim = pendingClaims[joinEquipmentId];
          const st = getUserStatus(joinEquipmentId);
          const inQueue = st?.startsWith("queued-") || st === "claim";
          const now = Date.now();

          return (
            <div className="space-y-5">
              <button onClick={() => setView(VIEWS.HOME)} className="text-blue-400 text-sm hover:underline">← Back</button>

              <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 text-center">
                <div className="text-4xl mb-2">{eq.icon}</div>
                <h1 className="text-xl font-bold">{eq.name}</h1>
                <p className="text-xs text-gray-400 mt-1">Time limit: {eq.timeLimitMin} minutes</p>
              </div>

              {/* Active session display */}
              {session && (
                <div className={`rounded-2xl p-5 border ${session.userId === currentUser.username ? "bg-green-900/20 border-green-700" : "bg-gray-900 border-gray-800"}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-sm text-green-400">● Currently In Use</h2>
                    <span className="text-xs text-gray-400">by {session.displayName}{session.userId === currentUser.username ? " (you)" : ""}</span>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-mono font-bold mb-1">{fmtTime(session.expiresAt - now)}</div>
                    <p className="text-xs text-gray-400">remaining</p>
                    {/* Progress bar */}
                    <div className="w-full bg-gray-800 rounded-full h-2 mt-3">
                      <div className="bg-green-500 h-2 rounded-full transition-all"
                        style={{ width: `${Math.max(0, Math.min(100, ((session.expiresAt - now) / (eq.timeLimitMin * 60000)) * 100))}%` }} />
                    </div>
                  </div>
                  {session.userId === currentUser.username && (
                    <button onClick={() => endSession(joinEquipmentId)}
                      className="w-full mt-4 bg-red-700 hover:bg-red-600 py-3 rounded-xl font-semibold transition">
                      End Session Early
                    </button>
                  )}
                </div>
              )}

              {/* Pending claim */}
              {claim && !session && (
                <div className={`rounded-2xl p-5 border ${claim.userId === currentUser.username ? "bg-yellow-900/20 border-yellow-600" : "bg-gray-900 border-gray-800"}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-sm text-yellow-400">⏳ Waiting to Start</h2>
                    <span className="text-xs text-gray-400">{claim.displayName}{claim.userId === currentUser.username ? " (you)" : ""}</span>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-mono font-bold mb-1">{fmtTime(claim.claimExpiresAt - now)}</div>
                    <p className="text-xs text-gray-400">to claim turn before it goes to the next person</p>
                    <div className="w-full bg-gray-800 rounded-full h-2 mt-3">
                      <div className="bg-yellow-500 h-2 rounded-full transition-all"
                        style={{ width: `${Math.max(0, Math.min(100, ((claim.claimExpiresAt - now) / (CLAIM_TIMEOUT * 1000)) * 100))}%` }} />
                    </div>
                  </div>
                  {claim.userId === currentUser.username && (
                    <button onClick={() => claimTurn(joinEquipmentId)}
                      className="w-full mt-4 bg-green-600 hover:bg-green-500 py-3 rounded-xl font-bold text-lg transition animate-pulse">
                      ▶ Start Your Turn
                    </button>
                  )}
                </div>
              )}

              {/* Join / Leave */}
              {st === "active" ? null : inQueue ? (
                <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center">
                  <p className="text-sm mb-3">You're in this queue {st?.startsWith("queued-") ? `at position #${parseInt(st.split("-")[1]) + 1}` : ""}</p>
                  <button onClick={() => leaveQueue(joinEquipmentId)}
                    className="bg-red-800 hover:bg-red-700 px-6 py-2.5 rounded-xl text-sm font-medium transition">
                    Leave Queue
                  </button>
                </div>
              ) : !session || session.userId !== currentUser.username ? (
                <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center">
                  <button onClick={() => addToQueue(joinEquipmentId)}
                    className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition text-lg">
                    Join Queue
                  </button>
                  <p className="text-xs text-gray-500 mt-2">
                    {!session && !claim && q.length === 0
                      ? "No one's waiting — you'll get it immediately!"
                      : `${q.length} ${q.length === 1 ? "person" : "people"} ahead of you`}
                  </p>
                </div>
              ) : null}

              {/* Queue list */}
              {q.length > 0 && (
                <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-800">
                    <h2 className="font-semibold text-sm">Queue</h2>
                  </div>
                  {q.map((u, i) => (
                    <div key={u.userId} className={`flex items-center justify-between px-5 py-3 border-b border-gray-800 last:border-0 ${u.userId === currentUser.username ? "bg-blue-900/10" : ""}`}>
                      <div className="flex items-center gap-3">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 ? "bg-yellow-500 text-black" : "bg-gray-700"}`}>
                          {i + 1}
                        </span>
                        <span className="text-sm font-medium">
                          {u.displayName}{u.userId === currentUser.username ? " (you)" : ""}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">{fmtAgo(u.joinedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* ADMIN */}
        {view === VIEWS.ADMIN && isAdmin && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold">Admin Panel</h1>
              <p className="text-gray-400 text-sm">Generate QR codes for equipment</p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                <p className="text-2xl font-bold">{Object.values(activeSessions).length}</p>
                <p className="text-xs text-gray-400">Active</p>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                <p className="text-2xl font-bold">{Object.values(queues).reduce((s, q) => s + q.length, 0)}</p>
                <p className="text-xs text-gray-400">In Queues</p>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                <p className="text-2xl font-bold">{accounts.length - 1}</p>
                <p className="text-xs text-gray-400">Users</p>
              </div>
            </div>

            {EQUIPMENT.map(eq => {
              const q = queues[eq.id] || [];
              const session = activeSessions[eq.id];
              const claim = pendingClaims[eq.id];
              const now = Date.now();
              return (
                <div key={eq.id} className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
                  <div className="p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{eq.icon}</span>
                        <div>
                          <h2 className="font-bold">{eq.name}</h2>
                          <p className="text-xs text-gray-400">{eq.timeLimitMin}min limit • {q.length} queued</p>
                        </div>
                      </div>
                      <button onClick={() => { setSelectedEquipment(eq.id); setView(VIEWS.QR); }}
                        className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-xs font-medium transition">
                        🖨️ Print QR
                      </button>
                    </div>
                    {session && (
                      <div className="bg-green-900/30 border border-green-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                        <div className="text-sm">
                          <span className="text-green-400 font-medium">{session.displayName}</span>
                          <span className="text-gray-400 ml-2 text-xs">{fmtTime(session.expiresAt - now)} remaining</span>
                        </div>
                      </div>
                    )}
                    {claim && !session && (
                      <div className="bg-yellow-900/30 border border-yellow-800 rounded-xl p-3 mb-3">
                        <span className="text-yellow-400 text-sm font-medium">{claim.displayName}</span>
                        <span className="text-gray-400 ml-2 text-xs">has {fmtTime(claim.claimExpiresAt - now)} to claim</span>
                      </div>
                    )}
                    {q.length > 0 && (
                      <div className="space-y-1">
                        {q.map((u, i) => (
                          <div key={u.userId} className="flex items-center gap-2 text-sm text-gray-300">
                            <span className="text-xs text-gray-500 w-5">{i + 1}.</span>
                            <span>{u.displayName}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {!session && !claim && q.length === 0 && <p className="text-sm text-gray-500">Available</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* QR VIEW */}
        {view === VIEWS.QR && selectedEquipment && (() => {
          const eq = EQUIPMENT.find(e => e.id === selectedEquipment);
          return (
            <div className="space-y-5">
              <button onClick={() => setView(VIEWS.ADMIN)} className="text-blue-400 text-sm hover:underline">← Back</button>
              <div className="bg-white rounded-2xl p-8 text-center text-black max-w-sm mx-auto">
                <div className="text-4xl mb-2">{eq.icon}</div>
                <h1 className="text-xl font-bold mb-1">{eq.name}</h1>
                <p className="text-gray-500 text-sm mb-1">Scan to join the queue</p>
                <p className="text-gray-400 text-xs mb-4">Time limit: {eq.timeLimitMin} minutes</p>
                <canvas ref={qrCanvasRef} className="mx-auto border border-gray-200 rounded-lg" />
                <p className="text-xs text-gray-400 mt-4 font-mono bg-gray-100 rounded-lg py-2 px-3">GYMQ:{selectedEquipment}</p>
                <p className="text-xs text-gray-400 mt-2">Powered by GymQueue</p>
              </div>
              <div className="text-center">
                <button onClick={() => {
                  const pw = window.open("", "_blank");
                  const cv = qrCanvasRef.current;
                  if (!pw || !cv) return;
                  pw.document.write(`<html><head><title>QR - ${eq.name}</title>
                    <style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:system-ui}
                    .card{text-align:center;padding:40px;border:2px solid #eee;border-radius:16px}
                    img{margin:20px auto;display:block}.code{font-family:monospace;background:#f5f5f5;padding:8px 16px;border-radius:8px;font-size:12px;color:#666}</style></head>
                    <body><div class="card"><div style="font-size:48px">${eq.icon}</div>
                    <h1>${eq.name}</h1><p>Scan to join the queue</p><p style="color:#999;font-size:14px">Time limit: ${eq.timeLimitMin} min</p>
                    <img src="${cv.toDataURL()}" width="256" height="256"/>
                    <p class="code">GYMQ:${selectedEquipment}</p>
                    <p style="color:#999;font-size:12px;margin-top:16px">Powered by GymQueue</p>
                    </div></body></html>`);
                  pw.document.close(); pw.print();
                }} className="bg-indigo-600 hover:bg-indigo-500 px-6 py-3 rounded-xl font-medium transition inline-flex items-center gap-2">
                  🖨️ Print QR Code
                </button>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}

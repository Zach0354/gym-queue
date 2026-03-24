import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase.jsx";

const QR_SIZE = 256;
const CLAIM_TIMEOUT = 120;

const drawQR = (canvas, text, size = QR_SIZE) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width = size; canvas.height = size;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
  const mc = 21, cs = size / mc;
  const bytes = []; for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
  ctx.fillStyle = "#000";
  const drawFinder = (x, y) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        ctx.fillRect((x + c) * cs, (y + r) * cs, cs, cs);
    }
  };
  drawFinder(0, 0); drawFinder(mc - 7, 0); drawFinder(0, mc - 7);
  for (let i = 8; i < mc - 8; i++) if (i % 2 === 0) {
    ctx.fillRect(i * cs, 6 * cs, cs, cs); ctx.fillRect(6 * cs, i * cs, cs, cs);
  }
  let bi = 0; const bits = [], lb = [];
  for (let bit = 7; bit >= 0; bit--) lb.push((text.length >> bit) & 1);
  for (const b of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((b >> bit) & 1);
  const db = [...lb, ...bits];
  for (let col = mc - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5;
    for (let row = 0; row < mc; row++) for (let c = 0; c < 2; c++) {
      const x = col - c, y = row;
      if (x < 8 && y < 8) continue; if (x >= mc - 7 && y < 8) continue;
      if (x < 8 && y >= mc - 7) continue; if (x === 6 || y === 6) continue;
      if (bi < db.length && db[bi]) ctx.fillRect(x * cs, y * cs, cs, cs); bi++;
    }
  }
};

const VIEWS = { AUTH: "auth", HOME: "home", ADMIN: "admin", JOIN: "join", QR: "qr", PROFILE: "profile" };

export default function App() {
  const [view, setView] = useState(VIEWS.AUTH);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ username: "", password: "", displayName: "" });
  const [authError, setAuthError] = useState("");
  const [loading, setLoading] = useState(false);

  const [currentUser, setCurrentUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [queues, setQueues] = useState({});
  const [activeSessions, setActiveSessions] = useState({});
  const [pendingClaims, setPendingClaims] = useState({});

  const [selectedEquipment, setSelectedEquipment] = useState(null);
  const [joinEquipmentId, setJoinEquipmentId] = useState(null);
  const [scanInput, setScanInput] = useState("");
  const [toast, setToast] = useState(null);
  const qrCanvasRef = useRef(null);
  const [, setTick] = useState(0);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3000);
  };

  // ---- Data fetching ----
  const fetchEquipment = async () => {
    const { data } = await supabase.from("equipment").select("*").order("name");
    if (data) setEquipment(data);
    return data || [];
  };

  const fetchQueues = useCallback(async (equip) => {
    const eqList = equip || equipment;
    const { data } = await supabase.from("queue_entries").select("*").order("joined_at", { ascending: true });
    if (data) {
      const map = {};
      eqList.forEach(e => (map[e.id] = []));
      // Batch fetch all profiles we need
      const userIds = [...new Set(data.map(d => d.user_id))];
      const profiles = {};
      if (userIds.length > 0) {
        const { data: profs } = await supabase.from("profiles").select("*").in("id", userIds);
        if (profs) profs.forEach(p => (profiles[p.id] = p));
      }
      for (const entry of data) {
        const prof = profiles[entry.user_id];
        if (!map[entry.equipment_id]) map[entry.equipment_id] = [];
        map[entry.equipment_id].push({
          ...entry,
          displayName: prof?.display_name || "Unknown",
          username: prof?.username,
        });
      }
      setQueues(map);
    }
  }, [equipment]);

  const fetchSessions = async () => {
    const { data } = await supabase.from("active_sessions").select("*");
    if (data) {
      const userIds = [...new Set(data.map(d => d.user_id))];
      const profiles = {};
      if (userIds.length > 0) {
        const { data: profs } = await supabase.from("profiles").select("*").in("id", userIds);
        if (profs) profs.forEach(p => (profiles[p.id] = p));
      }
      const map = {};
      for (const s of data) {
        const prof = profiles[s.user_id];
        map[s.equipment_id] = { ...s, displayName: prof?.display_name || "Unknown", userId: s.user_id };
      }
      setActiveSessions(map);
    }
  };

  const fetchClaims = async () => {
    const { data } = await supabase.from("pending_claims").select("*");
    if (data) {
      const userIds = [...new Set(data.map(d => d.user_id))];
      const profiles = {};
      if (userIds.length > 0) {
        const { data: profs } = await supabase.from("profiles").select("*").in("id", userIds);
        if (profs) profs.forEach(p => (profiles[p.id] = p));
      }
      const map = {};
      for (const c of data) {
        const prof = profiles[c.user_id];
        map[c.equipment_id] = { ...c, displayName: prof?.display_name || "Unknown", userId: c.user_id };
      }
      setPendingClaims(map);
    }
  };

  const refreshAll = useCallback(async (equip) => {
    await fetchQueues(equip);
    await fetchSessions();
    await fetchClaims();
  }, [fetchQueues]);

  // ---- Check for existing session on load ----
  useEffect(() => {
    const checkSession = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: prof } = await supabase.from("profiles").select("*").eq("id", user.id).single();
        if (prof) {
          setCurrentUser(user);
          setProfile(prof);
          const eqData = await fetchEquipment();
          await refreshAll(eqData);
          setView(VIEWS.HOME);
        }
      }
    };
    checkSession();
  }, []);

  // ---- Auth ----
  const handleAuth = async () => {
    setAuthError(""); setLoading(true);
    const { username, password, displayName } = authForm;
    if (!username.trim() || !password.trim()) { setAuthError("All fields required"); setLoading(false); return; }

    const email = `${username.trim().toLowerCase()}@gymqueue.app`;

    if (authMode === "register") {
      if (!displayName.trim()) { setAuthError("Display name required"); setLoading(false); return; }
      if (password.length < 4) { setAuthError("Password must be 4+ characters"); setLoading(false); return; }

      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName.trim() } } });
      if (error) { setAuthError(error.message); setLoading(false); return; }

      const { error: profError } = await supabase.from("profiles").insert({
        id: data.user.id,
        username: username.trim().toLowerCase(),
        display_name: displayName.trim(),
        role: "user",
      });
      if (profError) { setAuthError(profError.message); setLoading(false); return; }

      const prof = { id: data.user.id, username: username.trim().toLowerCase(), display_name: displayName.trim(), role: "user" };
      setCurrentUser(data.user);
      setProfile(prof);
      showToast(`Welcome, ${prof.display_name}!`);
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { setAuthError("Invalid username or password"); setLoading(false); return; }

      const { data: prof } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
      setCurrentUser(data.user);
      setProfile(prof);
      showToast(`Welcome back, ${prof?.display_name}!`);
    }

    const eqData = await fetchEquipment();
    await refreshAll(eqData);
    setView(VIEWS.HOME);
    setAuthForm({ username: "", password: "", displayName: "" });
    setLoading(false);
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setCurrentUser(null); setProfile(null);
    setQueues({}); setActiveSessions({}); setPendingClaims({});
    setView(VIEWS.AUTH);
  };

  // ---- Realtime subscriptions ----
  useEffect(() => {
    if (!currentUser || equipment.length === 0) return;
    const channel = supabase.channel("gym-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries" }, () => refreshAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "active_sessions" }, () => refreshAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "pending_claims" }, () => refreshAll())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [currentUser, equipment, refreshAll]);

  // ---- Timer: countdown display + expiry checks ----
  useEffect(() => {
    if (!currentUser) return;
    const t = setInterval(async () => {
      setTick(n => n + 1);
      const now = Date.now();

      // Check expired claims
      for (const [eqId, claim] of Object.entries(pendingClaims)) {
        if (claim && new Date(claim.claim_expires_at).getTime() <= now) {
          await supabase.from("pending_claims").delete().eq("equipment_id", eqId);
          await supabase.from("queue_entries").delete().eq("equipment_id", eqId).eq("user_id", claim.userId);
          const q = (queues[eqId] || []).filter(u => u.user_id !== claim.userId);
          if (q.length > 0) {
            await supabase.from("pending_claims").insert({
              equipment_id: eqId, user_id: q[0].user_id,
              claim_expires_at: new Date(now + CLAIM_TIMEOUT * 1000).toISOString(),
            });
          }
          await refreshAll();
        }
      }

      // Check expired sessions
      for (const [eqId, session] of Object.entries(activeSessions)) {
        if (session && new Date(session.expires_at).getTime() <= now) {
          await supabase.from("active_sessions").delete().eq("equipment_id", eqId);
          const q = queues[eqId] || [];
          if (q.length > 0) {
            await supabase.from("pending_claims").insert({
              equipment_id: eqId, user_id: q[0].user_id,
              claim_expires_at: new Date(now + CLAIM_TIMEOUT * 1000).toISOString(),
            });
          }
          await refreshAll();
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [currentUser, pendingClaims, activeSessions, queues, refreshAll]);

  // ---- Queue actions ----
 const addToQueue = async (equipId) => {
    if (!profile) return;
    const q = queues[equipId] || [];
    if (q.find(u => u.user_id === profile.id)) { showToast("Already in this queue!", "error"); return; }

    const { error } = await supabase.from("queue_entries").insert({ equipment_id: equipId, user_id: profile.id });
    if (error) { console.log("JOIN ERROR:", error); showToast("Failed to join queue: " + error.message, "error"); return; }

    // Check if equipment is free and no pending claim exists
    const { data: existingSession } = await supabase.from("active_sessions").select("*").eq("equipment_id", equipId);
    const { data: existingClaim } = await supabase.from("pending_claims").select("*").eq("equipment_id", equipId);
    const { data: currentQueue } = await supabase.from("queue_entries").select("*").eq("equipment_id", equipId).order("joined_at", { ascending: true });

    if ((!existingSession || existingSession.length === 0) && (!existingClaim || existingClaim.length === 0)) {
      if (currentQueue && currentQueue.length > 0 && currentQueue[0].user_id === profile.id) {
        await supabase.from("pending_claims").insert({
          equipment_id: equipId, user_id: profile.id,
          claim_expires_at: new Date(Date.now() + CLAIM_TIMEOUT * 1000).toISOString(),
        });
      }
    }

    const eq = equipment.find(e => e.id === equipId);
    showToast(`Added to ${eq?.name} queue!`);
    await refreshAll();
  };

    const eq = equipment.find(e => e.id === equipId);
    showToast(`Added to ${eq?.name} queue!`);
    await refreshAll();
  };

  const leaveQueue = async (equipId) => {
    if (!profile) return;
    const q = queues[equipId] || [];
    const isFirst = q[0]?.user_id === profile.id;

    await supabase.from("queue_entries").delete().eq("equipment_id", equipId).eq("user_id", profile.id);

    if (isFirst && pendingClaims[equipId]?.userId === profile.id) {
      await supabase.from("pending_claims").delete().eq("equipment_id", equipId);
      const remaining = q.filter(u => u.user_id !== profile.id);
      if (remaining.length > 0) {
        await supabase.from("pending_claims").insert({
          equipment_id: equipId, user_id: remaining[0].user_id,
          claim_expires_at: new Date(Date.now() + CLAIM_TIMEOUT * 1000).toISOString(),
        });
      }
    }
    showToast("Left the queue");
    await refreshAll();
  };

 const claimTurn = async (equipId) => {
    if (!profile) return;
    const claim = pendingClaims[equipId];
    if (!claim || claim.userId !== profile.id) return;
    const eq = equipment.find(e => e.id === equipId);

    console.log("CLAIMING:", { equipId, userId: profile.id });

    const { error: sessionError } = await supabase.from("active_sessions").insert({
      equipment_id: equipId, user_id: profile.id,
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + eq.time_limit_min * 60000).toISOString(),
    });
    if (sessionError) { console.log("SESSION ERROR:", sessionError); showToast("Failed to start: " + sessionError.message, "error"); return; }

    const { error: claimDelError } = await supabase.from("pending_claims").delete().eq("equipment_id", equipId);
    if (claimDelError) console.log("CLAIM DELETE ERROR:", claimDelError);

    const { error: queueDelError } = await supabase.from("queue_entries").delete().eq("equipment_id", equipId).eq("user_id", profile.id);
    if (queueDelError) console.log("QUEUE DELETE ERROR:", queueDelError);

    showToast(`Started on ${eq.name}! You have ${eq.time_limit_min} minutes.`);
    await refreshAll();
  };


 const endSession = async (equipId) => {
    if (!profile) return;
    const session = activeSessions[equipId];
    if (!session || session.userId !== profile.id) return;

    console.log("ENDING SESSION:", { equipId, userId: profile.id });

    await supabase.from("active_sessions").delete().eq("equipment_id", equipId);

    // Fetch the current queue directly from Supabase (not stale local state)
    const { data: currentQueue } = await supabase
      .from("queue_entries")
      .select("*")
      .eq("equipment_id", equipId)
      .order("joined_at", { ascending: true });

    if (currentQueue && currentQueue.length > 0) {
      const { data: existingClaim } = await supabase
        .from("pending_claims")
        .select("*")
        .eq("equipment_id", equipId);

      if (!existingClaim || existingClaim.length === 0) {
        const { error: claimError } = await supabase.from("pending_claims").insert({
          equipment_id: equipId,
          user_id: currentQueue[0].user_id,
          claim_expires_at: new Date(Date.now() + CLAIM_TIMEOUT * 1000).toISOString(),
        });
        if (claimError) console.log("PROMOTE CLAIM ERROR:", claimError);
        else console.log("PROMOTED:", currentQueue[0].user_id);
      }
    }

    showToast("Session ended!");
    await refreshAll();
  };

    showToast("Session ended!");
    await refreshAll();
  };

  // ---- QR ----
  useEffect(() => {
    if (!currentUser) return;
    const t = setInterval(async () => {
      setTick(n => n + 1);
      const now = Date.now();

      for (const [eqId, claim] of Object.entries(pendingClaims)) {
        if (claim && new Date(claim.claim_expires_at).getTime() <= now) {
          try {
            await supabase.from("pending_claims").delete().eq("equipment_id", eqId);
            await supabase.from("queue_entries").delete().eq("equipment_id", eqId).eq("user_id", claim.userId);
            const q = (queues[eqId] || []).filter(u => u.user_id !== claim.userId);
            if (q.length > 0 && !activeSessions[eqId]) {
              const { data: existing } = await supabase.from("pending_claims").select("*").eq("equipment_id", eqId);
              if (!existing || existing.length === 0) {
                await supabase.from("pending_claims").insert({
                  equipment_id: eqId, user_id: q[0].user_id,
                  claim_expires_at: new Date(now + CLAIM_TIMEOUT * 1000).toISOString(),
                });
              }
            }
          } catch (e) { console.log("Claim expiry error:", e); }
          await refreshAll();
        }
      }

      for (const [eqId, session] of Object.entries(activeSessions)) {
        if (session && new Date(session.expires_at).getTime() <= now) {
          try {
            await supabase.from("active_sessions").delete().eq("equipment_id", eqId);
            const q = queues[eqId] || [];
            if (q.length > 0) {
              const { data: existing } = await supabase.from("pending_claims").select("*").eq("equipment_id", eqId);
              if (!existing || existing.length === 0) {
                await supabase.from("pending_claims").insert({
                  equipment_id: eqId, user_id: q[0].user_id,
                  claim_expires_at: new Date(now + CLAIM_TIMEOUT * 1000).toISOString(),
                });
              }
            }
          } catch (e) { console.log("Session expiry error:", e); }
          await refreshAll();
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [currentUser, pendingClaims, activeSessions, queues, refreshAll]);

  const handleScanSubmit = () => {
    const trimmed = scanInput.trim();
    if (trimmed.startsWith("GYMQ:")) {
      const eqId = trimmed.replace("GYMQ:", "");
      if (equipment.find(e => e.id === eqId)) {
        setJoinEquipmentId(eqId); setView(VIEWS.JOIN); setScanInput(""); return;
      }
    }
    showToast("Invalid QR code data.", "error");
  };

  // ---- Helpers ----
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, "0")}`;
  };
  const fmtAgo = (ts) => {
    const d = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    return d < 1 ? "just now" : `${d}m ago`;
  };
  const isAdmin = profile?.role === "admin";
  const getUserStatus = (eqId) => {
    if (!profile) return null;
    if (activeSessions[eqId]?.userId === profile.id) return "active";
    if (pendingClaims[eqId]?.userId === profile.id) return "claim";
    const q = queues[eqId] || [];
    const pos = q.findIndex(u => u.user_id === profile.id);
    if (pos >= 0) return `queued-${pos}`;
    return null;
  };

  // ============ RENDER ============

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
              <button onClick={() => { setAuthMode("login"); setAuthError(""); }}
                className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${authMode === "login" ? "bg-blue-600" : ""}`}>Log In</button>
              <button onClick={() => { setAuthMode("register"); setAuthError(""); }}
                className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${authMode === "register" ? "bg-blue-600" : ""}`}>Sign Up</button>
            </div>
            {authMode === "register" && (
              <input value={authForm.displayName} onChange={e => setAuthForm(p => ({ ...p, displayName: e.target.value }))}
                placeholder="Display Name" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500" />
            )}
            <input value={authForm.username} onChange={e => setAuthForm(p => ({ ...p, username: e.target.value }))}
              placeholder="Username" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
              onKeyDown={e => e.key === "Enter" && handleAuth()} />
            <input value={authForm.password} onChange={e => setAuthForm(p => ({ ...p, password: e.target.value }))}
              type="password" placeholder="Password"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
              onKeyDown={e => e.key === "Enter" && handleAuth()} />
            {authError && <p className="text-red-400 text-xs">{authError}</p>}
            <button onClick={handleAuth} disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition disabled:opacity-50">
              {loading ? "Please wait..." : authMode === "login" ? "Log In" : "Create Account"}
            </button>
            {authMode === "login" && <p className="text-xs text-gray-500 text-center">Admin: admin / admin123</p>}
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
            <span className="text-2xl">🏋️</span><span className="font-bold text-lg">GymQueue</span>
          </button>
          <div className="flex items-center gap-2">
            <button onClick={() => setView(VIEWS.HOME)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${view === VIEWS.HOME || view === VIEWS.JOIN ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}>Equipment</button>
            {isAdmin && <button onClick={() => setView(VIEWS.ADMIN)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${view === VIEWS.ADMIN || view === VIEWS.QR ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}>Admin</button>}
            <button onClick={() => setView(VIEWS.PROFILE)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${view === VIEWS.PROFILE ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center text-xs font-bold">
                  {profile?.display_name?.[0]?.toUpperCase()}
                </span>
                <span className="hidden sm:inline">{profile?.display_name}</span>
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
                {profile?.display_name?.[0]?.toUpperCase()}
              </div>
              <h1 className="text-xl font-bold">{profile?.display_name}</h1>
              <p className="text-gray-400 text-sm">@{profile?.username}</p>
              {isAdmin && <span className="inline-block mt-2 bg-yellow-600 text-xs font-semibold px-3 py-1 rounded-full">ADMIN</span>}
            </div>
            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-5">
              <h2 className="font-semibold mb-3 text-sm text-gray-300 uppercase tracking-wide">My Activity</h2>
              {(() => {
                const items = [];
                equipment.forEach(eq => {
                  const st = getUserStatus(eq.id);
                  if (st === "active") items.push({ eq, label: "Using now", color: "text-green-400" });
                  else if (st === "claim") items.push({ eq, label: "Your turn! Claim it", color: "text-yellow-400" });
                  else if (st?.startsWith("queued-")) items.push({ eq, label: `#${parseInt(st.split("-")[1]) + 1} in queue`, color: "text-blue-400" });
                });
                if (!items.length) return <p className="text-sm text-gray-500">You're not in any queues</p>;
                return items.map(({ eq, label, color }) => (
                  <div key={eq.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{eq.icon}</span>
                      <div><p className="text-sm font-medium">{eq.name}</p><p className={`text-xs ${color}`}>{label}</p></div>
                    </div>
                    <button onClick={() => { setJoinEquipmentId(eq.id); setView(VIEWS.JOIN); }}
                      className="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition">View</button>
                  </div>
                ));
              })()}
            </div>
            <button onClick={logout} className="w-full bg-red-800 hover:bg-red-700 py-3 rounded-xl font-medium transition">Log Out</button>
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
                  placeholder="Paste scanned QR data..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  onKeyDown={e => e.key === "Enter" && handleScanSubmit()} />
                <button onClick={handleScanSubmit}
                  className="bg-blue-600 hover:bg-blue-500 px-5 py-2.5 rounded-xl text-sm font-medium transition">Go</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {equipment.map(eq => {
                const qLen = (queues[eq.id] || []).length;
                const session = activeSessions[eq.id];
                const claim = pendingClaims[eq.id];
                const st = getUserStatus(eq.id);
                const isYourTurn = st === "claim";
                return (
                  <button key={eq.id} onClick={() => { setJoinEquipmentId(eq.id); setView(VIEWS.JOIN); }}
                    className={`bg-gray-900 border rounded-2xl p-4 text-left transition ${isYourTurn ? "border-yellow-500 ring-1 ring-yellow-500/30" : "border-gray-800 hover:border-blue-500"}`}>
                    <div className="text-2xl mb-2">{eq.icon}</div>
                    <div className="font-semibold text-sm">{eq.name}</div>
                    <div className="text-xs mt-1">
                      {session ? <span className="text-green-400">● In use{session.userId === profile?.id ? " (you)" : ""}</span>
                        : claim ? <span className="text-yellow-400">● Waiting to be claimed{isYourTurn ? " — YOUR TURN!" : ""}</span>
                        : <span className="text-gray-500">● Available</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{qLen} in queue • {eq.time_limit_min}min</div>
                    {st?.startsWith("queued-") && <div className="text-xs text-blue-400 mt-1">You're #{parseInt(st.split("-")[1]) + 1}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* JOIN / DETAIL */}
        {view === VIEWS.JOIN && joinEquipmentId && (() => {
          const eq = equipment.find(e => e.id === joinEquipmentId);
          if (!eq) return null;
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
                <p className="text-xs text-gray-400 mt-1">Time limit: {eq.time_limit_min} minutes</p>
              </div>

              {/* Active session */}
              {session && (
                <div className={`rounded-2xl p-5 border ${session.userId === profile?.id ? "bg-green-900/20 border-green-700" : "bg-gray-900 border-gray-800"}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-sm text-green-400">● Currently In Use</h2>
                    <span className="text-xs text-gray-400">by {session.displayName}{session.userId === profile?.id ? " (you)" : ""}</span>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-mono font-bold mb-1">{fmtTime(new Date(session.expires_at).getTime() - now)}</div>
                    <p className="text-xs text-gray-400">remaining</p>
                    <div className="w-full bg-gray-800 rounded-full h-2 mt-3">
                      <div className="bg-green-500 h-2 rounded-full transition-all"
                        style={{ width: `${Math.max(0, Math.min(100, ((new Date(session.expires_at).getTime() - now) / (eq.time_limit_min * 60000)) * 100))}%` }} />
                    </div>
                  </div>
                  {session.userId === profile?.id && (
                    <button onClick={() => endSession(joinEquipmentId)}
                      className="w-full mt-4 bg-red-700 hover:bg-red-600 py-3 rounded-xl font-semibold transition">End Session Early</button>
                  )}
                </div>
              )}

              {/* Pending claim */}
              {claim && !session && (
                <div className={`rounded-2xl p-5 border ${claim.userId === profile?.id ? "bg-yellow-900/20 border-yellow-600" : "bg-gray-900 border-gray-800"}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-sm text-yellow-400">⏳ Waiting to Start</h2>
                    <span className="text-xs text-gray-400">{claim.displayName}{claim.userId === profile?.id ? " (you)" : ""}</span>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-mono font-bold mb-1">{fmtTime(new Date(claim.claim_expires_at).getTime() - now)}</div>
                    <p className="text-xs text-gray-400">to claim before it moves to next person</p>
                    <div className="w-full bg-gray-800 rounded-full h-2 mt-3">
                      <div className="bg-yellow-500 h-2 rounded-full transition-all"
                        style={{ width: `${Math.max(0, Math.min(100, ((new Date(claim.claim_expires_at).getTime() - now) / (CLAIM_TIMEOUT * 1000)) * 100))}%` }} />
                    </div>
                  </div>
                  {claim.userId === profile?.id && (
                    <button onClick={() => claimTurn(joinEquipmentId)}
                      className="w-full mt-4 bg-green-600 hover:bg-green-500 py-3 rounded-xl font-bold text-lg transition animate-pulse">
                      ▶ Start Your Turn
                    </button>
                  )}
                </div>
              )}

              {/* Join / Leave buttons */}
              {st === "active" ? null : inQueue ? (
                <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center">
                  <p className="text-sm mb-3">You're in this queue{st?.startsWith("queued-") ? ` at position #${parseInt(st.split("-")[1]) + 1}` : ""}</p>
                  <button onClick={() => leaveQueue(joinEquipmentId)}
                    className="bg-red-800 hover:bg-red-700 px-6 py-2.5 rounded-xl text-sm font-medium transition">Leave Queue</button>
                </div>
              ) : !session || session.userId !== profile?.id ? (
                <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center">
                  <button onClick={() => addToQueue(joinEquipmentId)}
                    className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition text-lg">Join Queue</button>
                  <p className="text-xs text-gray-500 mt-2">
                    {!session && !claim && q.length === 0 ? "No one's waiting — you'll get it immediately!"
                      : `${q.length} ${q.length === 1 ? "person" : "people"} ahead of you`}
                  </p>
                </div>
              ) : null}

              {/* Queue list */}
              {q.length > 0 && (
                <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-800"><h2 className="font-semibold text-sm">Queue</h2></div>
                  {q.map((u, i) => (
                    <div key={u.user_id}
                      className={`flex items-center justify-between px-5 py-3 border-b border-gray-800 last:border-0 ${u.user_id === profile?.id ? "bg-blue-900/10" : ""}`}>
                      <div className="flex items-center gap-3">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 ? "bg-yellow-500 text-black" : "bg-gray-700"}`}>{i + 1}</span>
                        <span className="text-sm font-medium">{u.displayName}{u.user_id === profile?.id ? " (you)" : ""}</span>
                      </div>
                      <span className="text-xs text-gray-500">{fmtAgo(u.joined_at)}</span>
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
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                <p className="text-2xl font-bold">{Object.values(activeSessions).length}</p><p className="text-xs text-gray-400">Active</p>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                <p className="text-2xl font-bold">{Object.values(queues).reduce((s, q) => s + q.length, 0)}</p><p className="text-xs text-gray-400">In Queues</p>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                <p className="text-2xl font-bold">{equipment.length}</p><p className="text-xs text-gray-400">Equipment</p>
              </div>
            </div>
            {equipment.map(eq => {
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
                        <div><h2 className="font-bold">{eq.name}</h2><p className="text-xs text-gray-400">{eq.time_limit_min}min limit • {q.length} queued</p></div>
                      </div>
                      <button onClick={() => { setSelectedEquipment(eq.id); setView(VIEWS.QR); }}
                        className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-xs font-medium transition">🖨️ Print QR</button>
                    </div>
                    {session && (
                      <div className="bg-green-900/30 border border-green-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                        <span className="text-green-400 text-sm font-medium">{session.displayName}</span>
                        <span className="text-gray-400 text-xs">{fmtTime(new Date(session.expires_at).getTime() - now)} remaining</span>
                      </div>
                    )}
                    {claim && !session && (
                      <div className="bg-yellow-900/30 border border-yellow-800 rounded-xl p-3 mb-3">
                        <span className="text-yellow-400 text-sm font-medium">{claim.displayName}</span>
                        <span className="text-gray-400 ml-2 text-xs">has {fmtTime(new Date(claim.claim_expires_at).getTime() - now)} to claim</span>
                      </div>
                    )}
                    {q.length > 0 ? q.map((u, i) => (
                      <div key={u.user_id} className="flex items-center gap-2 text-sm text-gray-300 py-0.5">
                        <span className="text-xs text-gray-500 w-5">{i + 1}.</span><span>{u.displayName}</span>
                      </div>
                    )) : !session && !claim && <p className="text-sm text-gray-500">Available</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* QR CODE */}
        {view === VIEWS.QR && selectedEquipment && (() => {
          const eq = equipment.find(e => e.id === selectedEquipment);
          return (
            <div className="space-y-5">
              <button onClick={() => setView(VIEWS.ADMIN)} className="text-blue-400 text-sm hover:underline">← Back</button>
              <div className="bg-white rounded-2xl p-8 text-center text-black max-w-sm mx-auto">
                <div className="text-4xl mb-2">{eq.icon}</div>
                <h1 className="text-xl font-bold mb-1">{eq.name}</h1>
                <p className="text-gray-500 text-sm mb-1">Scan to join the queue</p>
                <p className="text-gray-400 text-xs mb-4">Time limit: {eq.time_limit_min} minutes</p>
                <canvas ref={qrCanvasRef} className="mx-auto border border-gray-200 rounded-lg" />
                <p className="text-xs text-gray-400 mt-4 font-mono bg-gray-100 rounded-lg py-2 px-3">GYMQ:{selectedEquipment}</p>
                <p className="text-xs text-gray-400 mt-2">Powered by GymQueue</p>
              </div>
              <div className="text-center">
                <button onClick={() => {
                  const pw = window.open("", "_blank"); const cv = qrCanvasRef.current;
                  if (!pw || !cv) return;
                  pw.document.write(`<html><head><title>QR - ${eq.name}</title><style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:system-ui}.card{text-align:center;padding:40px;border:2px solid #eee;border-radius:16px}img{margin:20px auto;display:block}.code{font-family:monospace;background:#f5f5f5;padding:8px 16px;border-radius:8px;font-size:12px;color:#666}</style></head><body><div class="card"><div style="font-size:48px">${eq.icon}</div><h1>${eq.name}</h1><p>Scan to join the queue</p><p style="color:#999;font-size:14px">Time limit: ${eq.time_limit_min} min</p><img src="${cv.toDataURL()}" width="256" height="256"/><p class="code">GYMQ:${selectedEquipment}</p><p style="color:#999;font-size:12px;margin-top:16px">Powered by GymQueue</p></div></body></html>`);
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
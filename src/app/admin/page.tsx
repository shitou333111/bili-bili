"use client";

import { useState, useEffect, useCallback } from "react";

function fixImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

type User = {
  sid: string;
  uname: string;
  mid: number;
  face?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  isCurrent: boolean;
};

type BlindBoxItem = { id: number; name: string; icon: string };
type ActivityItem = { id: string; type: string; info_url: string; record_url: string; active?: boolean };

type AdminConfigData = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  synthesis_activities: ActivityItem[];
  valid_activity_types: string[];
};

export default function AdminPage() {
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [config, setConfig] = useState<AdminConfigData | null>(null);
  const [configSaved, setConfigSaved] = useState(false);
  const [fetchingName, setFetchingName] = useState<number | null>(null);

  const checkAdminSession = useCallback(async () => {
    const res = await fetch("/api/admin/session");
    const data = await res.json();
    setAdminLoggedIn(data.data?.valid ?? false);
  }, []);

  useEffect(() => {
    checkAdminSession();
  }, [checkAdminSession]);

  const loadData = useCallback(async () => {
    const [usersRes, configRes] = await Promise.all([
      fetch("/api/admin/users"),
      fetch("/api/admin/config"),
    ]);
    const usersData = await usersRes.json();
    const configData = await configRes.json();
    if (usersData.code === 0) setUsers(usersData.data.users);
    if (configData.code === 0) setConfig(configData.data);
  }, []);

  useEffect(() => {
    if (adminLoggedIn) loadData();
  }, [adminLoggedIn, loadData]);

  const handleLogin = async () => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (res.ok) {
        setAdminLoggedIn(true);
      } else {
        const data = await res.json();
        setLoginError(data.message || "登录失败");
      }
    } catch {
      setLoginError("网络错误");
    }
    setLoginLoading(false);
  };

  const handleImpersonate = async (sid: string) => {
    await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid }),
    });
    setUsers((prev) =>
      prev.map((u) => ({ ...u, isCurrent: u.sid === sid })),
    );
    alert("已切换，现在可以用该用户身份访问首页");
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    setConfigSaved(false);
    const res = await fetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (data.code === 0) {
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
    } else {
      alert(data.message || "保存失败");
    }
  };

  const updateBlindBox = (index: number, field: keyof BlindBoxItem, value: string | number) => {
    if (!config) return;
    const boxes = [...config.blind_boxes];
    boxes[index] = { ...boxes[index], [field]: field === "id" ? Number(value) : value };
    setConfig({ ...config, blind_boxes: boxes });
  };

  const addBlindBox = () => {
    if (!config) return;
    setConfig({
      ...config,
      blind_boxes: [...config.blind_boxes, { id: 0, name: "", icon: "" }],
    });
  };

  const removeBlindBox = (index: number) => {
    if (!config) return;
    const removedId = config.blind_boxes[index]?.id;
    setConfig({
      ...config,
      blind_boxes: config.blind_boxes.filter((_, i) => i !== index),
      current_activity_blind_box_ids: removedId
        ? config.current_activity_blind_box_ids.filter((id) => id !== removedId)
        : config.current_activity_blind_box_ids,
    });
  };

  const updateActivity = (index: number, field: keyof ActivityItem, value: string) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    acts[index] = { ...acts[index], [field]: value };
    setConfig({ ...config, synthesis_activities: acts });
  };

  const addActivity = () => {
    if (!config) return;
    setConfig({
      ...config,
      synthesis_activities: [
        ...config.synthesis_activities,
        { id: "", type: config.valid_activity_types[0] || "material_package", info_url: "", record_url: "" },
      ],
    });
  };

  const removeActivity = (index: number) => {
    if (!config) return;
    setConfig({
      ...config,
      synthesis_activities: config.synthesis_activities.filter((_, i) => i !== index),
    });
  };

  const fetchBlindBoxName = async (index: number) => {
    if (!config) return;
    const box = config.blind_boxes[index];
    if (!box.id || box.id <= 0) return;
    setFetchingName(index);
    try {
      const res = await fetch(`/api/admin/blind-box-info?gift_id=${box.id}`);
      const data = await res.json();
      if (data.code === 0 && data.data?.name) {
        const boxes = [...config.blind_boxes];
        boxes[index] = { ...boxes[index], name: data.data.name };
        setConfig({ ...config, blind_boxes: boxes });
      } else {
        alert(data.message || "未找到盲盒信息");
      }
    } catch {
      alert("查询失败");
    }
    setFetchingName(null);
  };

  const toggleCurrentBoxId = (id: number) => {
    if (!config) return;
    const ids = config.current_activity_blind_box_ids;
    setConfig({
      ...config,
      current_activity_blind_box_ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    });
  };

  const toggleActivityActive = (index: number) => {
    if (!config) return;
    const acts = [...config.synthesis_activities];
    acts[index] = { ...acts[index], active: !acts[index].active };
    setConfig({ ...config, synthesis_activities: acts });
  };

  if (!adminLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9f6]">
        <div className="w-full max-w-xs rounded-xl border border-black/10 bg-white p-6 shadow-sm">
          <h1 className="text-base font-bold text-center mb-4">管理员登录</h1>
          {loginError && <p className="text-xs text-[#e74c3c] mb-2 text-center">{loginError}</p>}
          <input
            type="text"
            placeholder="用户名"
            value={loginForm.username}
            onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm mb-2 focus:outline-none focus:border-black/30"
          />
          <input
            type="password"
            placeholder="密码"
            value={loginForm.password}
            onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm mb-3 focus:outline-none focus:border-black/30"
          />
          <button
            onClick={handleLogin}
            disabled={loginLoading}
            className="w-full rounded-lg bg-[#1f1c17] py-2 text-sm text-white font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loginLoading ? "登录中..." : "登录"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf9f6] py-6 px-4">
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">管理后台</h1>
          <a href="/" className="text-xs text-black/40 hover:text-black/70 transition">← 返回首页</a>
        </div>

        {/* Users */}
        <div className="rounded-xl border border-black/10 bg-white/80 p-4">
          <h2 className="text-sm font-bold mb-3">用户列表 ({users.length})</h2>
          {users.length === 0 ? (
            <p className="text-xs text-black/30">暂无用户</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {users.map((user) => (
                <div key={user.mid} className={`flex items-center gap-3 rounded-lg border p-2.5 ${user.isCurrent ? "border-[#00a1d6] bg-[#eef3fb]" : "border-black/10"}`}>
                  <img src={fixImageUrl(user.face || "")} alt="" className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{user.uname}</span>
                      <span className="text-[10px] text-black/30">UID {user.mid}</span>
                      {user.isCurrent && <span className="text-[10px] px-1 rounded bg-[#00a1d6]/10 text-[#00a1d6]">当前</span>}
                    </div>
                    <span className="text-[10px] text-black/30">更新: {new Date(user.updatedAt).toLocaleString("zh-CN")}</span>
                  </div>
                  {!user.isCurrent && (
                    <button
                      onClick={() => handleImpersonate(user.sid)}
                      className="rounded-lg border border-black/10 bg-white px-3 py-1 text-xs text-black/60 hover:bg-black/5 transition"
                    >
                      切换
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Config */}
        {config && (
          <div className="rounded-xl border border-black/10 bg-white/80 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">配置管理</h2>
              <div className="flex items-center gap-2">
                {configSaved && <span className="text-xs text-[#2ecc71]">已保存 ✓</span>}
                <button
                  onClick={handleSaveConfig}
                  className="rounded-lg bg-[#1f1c17] px-4 py-1.5 text-xs text-white font-medium hover:opacity-90 transition"
                >
                  保存配置
                </button>
              </div>
            </div>

            {/* Blind boxes */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">盲盒配置</h3>
                <button onClick={addBlindBox} className="text-xs text-[#00a1d6] hover:underline">+ 添加盲盒</button>
              </div>
              <p className="text-[10px] text-black/40">勾选 = 在页面上展示为当前活动盲盒</p>
              <div className="space-y-2">
                {/* 心动盲盒 - 固定项，始终勾选，不可更改 */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={true}
                    disabled
                    className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0 opacity-50"
                  />
                  <span className="w-24 text-xs text-black/50">32251</span>
                  <span className="w-32 text-xs text-black/50">心动盲盒</span>
                  <span className="text-[10px] text-black/30 shrink-0">默认显示，不可更改</span>
                </div>
                {/* 其他盲盒 */}
                {config.blind_boxes.filter((box) => box.id !== 32251).map((box) => {
                  const realIndex = config.blind_boxes.findIndex((b) => b === box);
                  return (
                  <div key={realIndex} className={`flex items-center gap-2 ${!config.current_activity_blind_box_ids.includes(box.id) ? "opacity-50" : ""}`}>
                    <input
                      type="checkbox"
                      checked={config.current_activity_blind_box_ids.includes(box.id)}
                      onChange={() => toggleCurrentBoxId(box.id)}
                      className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0"
                      title="勾选为当前活动盲盒"
                    />
                    <input
                      type="text"
                      value={box.id || ""}
                      onChange={(e) => updateBlindBox(realIndex, "id", e.target.value)}
                      onBlur={() => { if (box.id > 0 && !box.name) fetchBlindBoxName(realIndex); }}
                      placeholder="gift_id"
                      className="w-24 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                    <input
                      type="text"
                      value={box.name}
                      readOnly
                      placeholder="自动获取"
                      className="w-32 rounded border border-black/10 bg-black/5 px-2 py-1.5 text-xs text-black/50 cursor-not-allowed"
                    />
                    {box.id > 0 && (
                      <button
                        onClick={() => fetchBlindBoxName(realIndex)}
                        disabled={fetchingName === realIndex}
                        className="text-[10px] text-[#00a1d6] hover:underline shrink-0 disabled:opacity-50"
                      >
                        {fetchingName === realIndex ? "查询中..." : "获取名称"}
                      </button>
                    )}
                    <input
                      type="text"
                      value={box.icon}
                      onChange={(e) => updateBlindBox(realIndex, "icon", e.target.value)}
                      placeholder="图标链接"
                      className="flex-1 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                    <button onClick={() => removeBlindBox(realIndex)} className="text-xs text-[#e74c3c] hover:underline shrink-0">删除</button>
                  </div>
                  );
                })}
              </div>
            </div>

            <hr className="border-black/5" />

            {/* Synthesis activities */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">合成活动配置</h3>
                <button onClick={addActivity} className="text-xs text-[#00a1d6] hover:underline">+ 添加活动</button>
              </div>
              <p className="text-[10px] text-black/40">勾选 = 在页面上展示该活动</p>
              <div className="space-y-3">
                {config.synthesis_activities.map((act, i) => (
                  <div key={i} className={`rounded-lg border border-black/10 p-3 space-y-2 ${act.active === false ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={act.active !== false}
                        onChange={() => toggleActivityActive(i)}
                        className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0"
                        title="勾选为展示活动"
                      />
                      <input
                        type="text"
                        value={act.id}
                        onChange={(e) => updateActivity(i, "id", e.target.value)}
                        placeholder="活动ID"
                        className="w-32 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                      />
                      <select
                        value={act.type}
                        onChange={(e) => updateActivity(i, "type", e.target.value)}
                        className="rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30 bg-white"
                      >
                        {config.valid_activity_types.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <button onClick={() => removeActivity(i)} className="text-xs text-[#e74c3c] hover:underline ml-auto">删除</button>
                    </div>
                    <input
                      type="text"
                      value={act.info_url}
                      onChange={(e) => updateActivity(i, "info_url", e.target.value)}
                      placeholder="info_url"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                    <input
                      type="text"
                      value={act.record_url}
                      onChange={(e) => updateActivity(i, "record_url", e.target.value)}
                      placeholder="record_url"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { serverApiUrl } from "@/lib/server-api";
import Dropdown from "@/components/Dropdown";

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
  lastUpload?: string;
  isCurrent: boolean;
  isLocal?: boolean;
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
  // 首次进入时静默校验/自动登录，期间不渲染登录框，避免“弹出后自动消失”的闪烁
  const [checking, setChecking] = useState(true);
  const [loginForm, setLoginForm] = useState({ password: "" });
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [config, setConfig] = useState<AdminConfigData | null>(null);
  const [configSaved, setConfigSaved] = useState(false);
  const [fetchingName, setFetchingName] = useState<number | null>(null);
  // 用户搜索
  const [userSearch, setUserSearch] = useState("");
  // 活动名称映射（从本地活动信息 JSON 读取，只读展示）
  const [activityNames, setActivityNames] = useState<Record<string, string>>({});

  const checkAdminSession = useCallback(async () => {
    const res = await fetch(serverApiUrl("/api/admin/session"));
    const data = await res.json();
    setAdminLoggedIn(data.data?.valid ?? false);
    setChecking(false);
  }, []);

  useEffect(() => {
    checkAdminSession();
  }, [checkAdminSession]);

  const loadActivityNames = useCallback(async (activities: ActivityItem[]) => {
    const names: Record<string, string> = {};
    await Promise.all(
      activities.map(async (act) => {
        if (!act.id) return;
        try {
          const res = await fetch(serverApiUrl(`/api/admin/activity-info?activity_id=${encodeURIComponent(act.id)}`));
          const data = await res.json();
          if (data.code === 0 && data.data?.name) {
            names[act.id] = data.data.name;
          }
        } catch { /* ignore */ }
      }),
    );
    setActivityNames(names);
  }, []);

  const loadData = useCallback(async () => {
    // 附带当前浏览器登录账号的 sid，用于默认选中当前用户
    const sid = typeof window !== "undefined" ? localStorage.getItem("bili_live_sid") : null;
    // 本机登录标识（稳定设备令牌），用于标记“本机登录”账号并置顶
    const deviceToken = typeof window !== "undefined"
      ? (localStorage.getItem("bili_live_device_token") ?? localStorage.getItem("bili_live_user_token") ?? "")
      : "";
    const usersUrl = sid
      ? `/api/admin/users?_sid=${encodeURIComponent(sid)}&_device_token=${encodeURIComponent(deviceToken)}`
      : `/api/admin/users?_device_token=${encodeURIComponent(deviceToken)}`;
    const [usersRes, configRes] = await Promise.all([
      fetch(serverApiUrl(usersUrl)),
      fetch(serverApiUrl("/api/admin/config")),
    ]);
    const usersData = await usersRes.json();
    const configData = await configRes.json();
    if (usersData.code === 0) setUsers(usersData.data.users);
    if (configData.code === 0) {
      setConfig(configData.data);
      loadActivityNames(configData.data.synthesis_activities ?? []);
    }
  }, [loadActivityNames]);

  useEffect(() => {
    if (adminLoggedIn) loadData();
  }, [adminLoggedIn, loadData]);

  const handleLogin = async () => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(serverApiUrl("/api/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginForm.password }),
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
    const res = await fetch(serverApiUrl("/api/admin/impersonate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid }),
    });
    const data = await res.json();
    // 更新 localStorage 中的 userToken 与 sid，确保首页和 admin 默认选中一致
    if (data.data?.userToken) {
      localStorage.setItem("bili_live_user_token", data.data.userToken);
    }
    localStorage.setItem("bili_live_sid", sid);
    setUsers((prev) =>
      prev.map((u) => ({ ...u, isCurrent: u.sid === sid })),
    );
  };

  const handleLoadRemoteData = async (user: User) => {
    try {
      // 先从服务器拉取该用户的数据文件
      const res = await fetch(serverApiUrl(`/api/upload?mid=${user.mid}&uname=${encodeURIComponent(user.uname)}`));
      const data = await res.json();
      if (data.code !== 0) {
        alert("加载失败: " + (data.message || "未知错误"));
        return;
      }
      const files = data.data?.files ?? {};
      const fileNames = Object.keys(files);
      if (fileNames.length === 0) {
        alert("该用户暂无上传数据");
        return;
      }
      // 切换到该用户并跳转到首页
      await handleImpersonate(user.sid);
      alert(`已加载 ${user.uname} 的 ${fileNames.length} 个数据文件 (${fileNames.join(", ")})，即将跳转首页`);
      window.location.href = "/";
    } catch (err) {
      alert("加载失败: " + (err instanceof Error ? err.message : "网络错误"));
    }
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    setConfigSaved(false);
    const res = await fetch(serverApiUrl("/api/admin/config"), {
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

  // 上移下移盲盒条目（固定盲盒 32251/35206 不参与排序，仅调整其余条目顺序）
  const moveBlindBox = (filteredIndex: number, dir: -1 | 1) => {
    if (!config) return;
    const fixedIds = [32251, 35206];
    const boxes = [...config.blind_boxes];
    const nonFixed: number[] = [];
    boxes.forEach((b, i) => { if (!fixedIds.includes(b.id)) nonFixed.push(i); });
    const target = filteredIndex + dir;
    if (target < 0 || target >= nonFixed.length) return;
    const a = nonFixed[filteredIndex];
    const b = nonFixed[target];
    [boxes[a], boxes[b]] = [boxes[b], boxes[a]];
    setConfig({ ...config, blind_boxes: boxes });
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

  // 上移下移合成活动条目
  const moveActivity = (index: number, dir: -1 | 1) => {
    if (!config) return;
    const target = index + dir;
    if (target < 0 || target >= config.synthesis_activities.length) return;
    const acts = [...config.synthesis_activities];
    [acts[index], acts[target]] = [acts[target], acts[index]];
    setConfig({ ...config, synthesis_activities: acts });
  };

  const fetchBlindBoxName = async (index: number) => {
    if (!config) return;
    const box = config.blind_boxes[index];
    if (!box.id || box.id <= 0) return;
    setFetchingName(index);
    try {
      const res = await fetch(serverApiUrl(`/api/admin/blind-box-info?gift_id=${box.id}`));
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

  // 按用户名或 UID 过滤用户
  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.uname.toLowerCase().includes(q) || String(u.mid).includes(q),
    );
  }, [users, userSearch]);

  if (checking) {
    // 静默校验/自动登录中，不渲染任何登录框，避免闪烁
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9f6]">
        <div className="w-8 h-8 border-2 border-black/15 border-t-black/40 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!adminLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9f6]">
        <div className="w-full max-w-xs rounded-xl border border-black/10 bg-white p-6 shadow-sm">
          <h1 className="text-base font-bold text-center mb-4">管理员登录</h1>
          {loginError && <p className="text-xs text-[#e74c3c] mb-2 text-center">{loginError}</p>}
          <input
            type="password"
            placeholder="请输入管理密码"
            value={loginForm.password}
            onChange={(e) => setLoginForm({ password: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm mb-3 focus:outline-none focus:border-black/30"
            autoFocus
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
    <div className="min-h-screen bg-[#faf9f6] py-6 px-4 overflow-x-hidden">
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">管理后台</h1>
          <a href="/" className="text-xs text-black/40 hover:text-black/70 transition">← 返回首页</a>
        </div>

        {/* Users */}
        <div className="rounded-xl border border-black/10 bg-white/80 p-4">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="text-sm font-bold">用户列表 ({filteredUsers.length})</h2>
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="搜索用户名 / UID"
              className="w-44 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs focus:outline-none focus:border-black/30"
            />
          </div>
          {filteredUsers.length === 0 ? (
            <p className="text-xs text-black/30">{users.length === 0 ? "暂无用户" : "无匹配用户"}</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {filteredUsers.map((user) => (
                <div key={user.mid} className={`flex items-center gap-3 rounded-lg border p-2.5 ${user.isCurrent ? "border-[#00a1d6] bg-[#eef3fb]" : "border-black/10"}`}>
                  <img src={fixImageUrl(user.face || "")} alt="" className="w-8 h-8 rounded-full flex-shrink-0 bg-black/5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-1.5">
                      <span className="text-sm font-medium min-w-0 break-all leading-snug">{user.uname}</span>
                      {user.isLocal && <span className="text-[10px] px-1.5 rounded bg-[#2ecc71]/10 text-[#2ecc71] shrink-0">本机</span>}
                      {user.isCurrent && <span className="text-[10px] px-1.5 rounded bg-[#00a1d6]/10 text-[#00a1d6] shrink-0">当前</span>}
                    </div>
                    <div className="text-[10px] text-black/30 mt-0.5">UID {user.mid}</div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                      <span className="text-[10px] text-black/30">更新: {new Date(user.updatedAt).toLocaleString("zh-CN")}</span>
                      {user.lastUpload && (
                        <span className="text-[10px] text-[#2ecc71]">
                          数据: {new Date(user.lastUpload).toLocaleString("zh-CN").slice(0, 10)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {user.lastUpload && (
                      <button
                        onClick={() => handleLoadRemoteData(user)}
                        className="rounded-lg border border-[#2ecc71]/30 bg-[#2ecc71]/5 px-2 py-1 text-[10px] text-[#2ecc71] hover:bg-[#2ecc71]/10 transition"
                        title="加载该用户上传的数据"
                      >
                        加载数据
                      </button>
                    )}
                    {!user.isCurrent && (
                      <button
                        onClick={() => { handleImpersonate(user.sid); window.location.href = "/"; }}
                        className="rounded-lg border border-black/10 bg-white px-3 py-1 text-xs text-black/60 hover:bg-black/5 transition"
                      >
                        切换
                      </button>
                    )}
                  </div>
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
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="checkbox"
                    checked={true}
                    disabled
                    className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0 opacity-50"
                  />
                  <span className="w-16 text-xs text-black/50">32251</span>
                  <span className="w-auto text-xs text-black/50">心动盲盒</span>
                  <span className="text-[10px] text-black/30 shrink-0">默认显示，不可更改</span>
                </div>
                {/* 幸运盲盒 - 固定项，始终勾选，不可更改 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="checkbox"
                    checked={true}
                    disabled
                    className="w-3.5 h-3.5 accent-[#00a1d6] shrink-0 opacity-50"
                  />
                  <span className="w-16 text-xs text-black/50">35206</span>
                  <span className="w-auto text-xs text-black/50">幸运盲盒</span>
                  <span className="text-[10px] text-black/30 shrink-0">默认显示，不可更改</span>
                </div>
                {/* 其他盲盒（可配置，支持上移下移排序） */}
                {config.blind_boxes
                  .filter((box) => box.id !== 32251 && box.id !== 35206)
                  .map((box, filteredIndex) => {
                    const realIndex = config.blind_boxes.findIndex((b) => b === box);
                    return (
                  <div key={realIndex} className={`rounded-lg border border-black/10 p-2 space-y-2 ${!config.current_activity_blind_box_ids.includes(box.id) ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => moveBlindBox(filteredIndex, -1)}
                          disabled={filteredIndex === 0}
                          className="admin-move-btn"
                          title="上移"
                        >▲</button>
                        <button
                          onClick={() => moveBlindBox(filteredIndex, 1)}
                          disabled={filteredIndex === config.blind_boxes.filter((b) => b.id !== 32251 && b.id !== 35206).length - 1}
                          className="admin-move-btn"
                          title="下移"
                        >▼</button>
                      </div>
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
                        className="w-20 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                      />
                      <input
                        type="text"
                        value={box.name}
                        readOnly
                        placeholder="自动获取"
                        className="flex-1 min-w-[110px] rounded border border-black/10 bg-black/5 px-2 py-1.5 text-xs text-black/50 cursor-not-allowed"
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
                      <button onClick={() => removeBlindBox(realIndex)} className="text-xs text-[#e74c3c] hover:underline shrink-0 ml-auto">删除</button>
                    </div>
                    <input
                      type="text"
                      value={box.icon}
                      onChange={(e) => updateBlindBox(realIndex, "icon", e.target.value)}
                      placeholder="图标链接"
                      className="w-full rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                    />
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
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => moveActivity(i, -1)}
                          disabled={i === 0}
                          className="admin-move-btn"
                          title="上移"
                        >▲</button>
                        <button
                          onClick={() => moveActivity(i, 1)}
                          disabled={i === config.synthesis_activities.length - 1}
                          className="admin-move-btn"
                          title="下移"
                        >▼</button>
                      </div>
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
                        className="w-24 rounded border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                      />
                      {/* 活动名称 - 自动从 info_url 提取，只读显示 */}
                      <input
                        type="text"
                        value={activityNames[act.id] ?? ""}
                        readOnly
                        placeholder="自动获取名称"
                        className="flex-1 min-w-[120px] rounded border border-black/10 bg-black/5 px-2 py-1.5 text-xs text-black/50 cursor-not-allowed"
                      />
                      <Dropdown
                        value={act.type}
                        onChange={(v) => updateActivity(i, "type", v)}
                        className="w-32 shrink-0 rounded border border-black/10 bg-white px-2 py-1.5 text-xs focus:outline-none focus:border-black/30"
                        options={config.valid_activity_types.map((t) => ({ value: t, label: t }))}
                      />
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

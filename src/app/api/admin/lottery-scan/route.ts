import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import {
  getAdminSnapshot,
  setScanEnabled,
  updateScanConfig,
  setScanAccount,
  addCustomRoom,
  removeCustomRoom,
  removeHistoryRoom,
  clearHistoryRooms,
} from "@/lib/lottery-scan";

export const dynamic = "force-dynamic";

/** 管理后台：读取扫描配置、运行状态、常发红包历史 */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const data = await getAdminSnapshot();
  return NextResponse.json({ code: 0, data });
}

type Body = {
  action?:
    | "setEnabled"
    | "setConfig"
    | "setAccount"
    | "addRoom"
    | "removeRoom"
    | "removeHistory"
    | "clearHistory";
  enabled?: boolean;
  roomid?: number;
  minValue?: number;
  scanIntervalMs?: number;
  requestIntervalMs?: number;
  redIntervalMs?: number;
  hotRoomsPerPartition?: number;
  cookie?: string;
  uid?: number;
};

/** 管理后台：启停扫描 / 修改阈值与频率 / 设置扫描账号 / 管理指定直播间 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ code: -1, message: "请求体格式错误" }, { status: 400 });
  }

  switch (body.action) {
    case "setEnabled": {
      const result = await setScanEnabled(!!body.enabled);
      if (!result.ok) {
        return NextResponse.json({ code: -1, message: result.message });
      }
      break;
    }
    case "setConfig": {
      await updateScanConfig({
        minValue: body.minValue,
        scanIntervalMs: body.scanIntervalMs,
        requestIntervalMs: body.requestIntervalMs,
        redIntervalMs: body.redIntervalMs,
        hotRoomsPerPartition: body.hotRoomsPerPartition,
      });
      break;
    }
    case "setAccount": {
      const result = await setScanAccount(body.cookie ?? "");
      if (!result.ok) {
        return NextResponse.json({ code: -1, message: result.message });
      }
      break;
    }
    case "addRoom": {
      const uid = Number(body.uid);
      if (!Number.isInteger(uid) || uid <= 0) {
        return NextResponse.json({ code: -1, message: "请输入有效的 UID" }, { status: 400 });
      }
      const result = await addCustomRoom(uid);
      if (!result.ok) {
        return NextResponse.json({ code: -1, message: result.message });
      }
      break;
    }
    case "removeRoom": {
      const uid = Number(body.uid);
      if (Number.isInteger(uid) && uid > 0) await removeCustomRoom(uid);
      break;
    }
    case "removeHistory": {
      const roomid = Number(body.roomid);
      if (Number.isInteger(roomid) && roomid > 0) await removeHistoryRoom(roomid);
      break;
    }
    case "clearHistory": {
      await clearHistoryRooms();
      break;
    }
    default:
      return NextResponse.json({ code: -1, message: "未知操作" }, { status: 400 });
  }

  const data = await getAdminSnapshot();
  return NextResponse.json({ code: 0, data });
}

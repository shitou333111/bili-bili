import { promises as fs } from "fs";
import path from "path";
import type { SynthesisActivityConfig, SynthesisActivityType } from "./config";

const CONFIG_FILE = path.join(process.cwd(), ".data", "admin-config.json");

export type BlindBoxItem = {
  id: number;
  name: string;
  icon: string;
};

export type AdminConfig = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  synthesis_activities: SynthesisActivityConfig[];
};

async function ensureConfigFile() {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(null, null, 2), "utf8");
  }
}

export async function readAdminConfig(): Promise<AdminConfig | null> {
  await ensureConfigFile();
  const raw = await fs.readFile(CONFIG_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AdminConfig;
  } catch {
    return null;
  }
}

export async function writeAdminConfig(config: AdminConfig) {
  await ensureConfigFile();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

const VALID_ACTIVITY_TYPES: SynthesisActivityType[] = ["slot_draw", "material_package", "card_flip"];

export function validateActivityType(type: string): type is SynthesisActivityType {
  return VALID_ACTIVITY_TYPES.includes(type as SynthesisActivityType);
}

export function getValidActivityTypes(): string[] {
  return VALID_ACTIVITY_TYPES;
}

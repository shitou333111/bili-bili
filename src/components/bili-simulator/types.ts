export interface Gift {
  id: number;
  name: string;
  price: number;
  img: string;
  effect_id?: number;
  corner_mark?: string;
  corner_background?: string;
  bag_gift?: number;
  coin_type?: string;
}

export interface EffectConfig {
  info: {
    aFrame: [number, number, number, number];
    rgbFrame: [number, number, number, number];
    f: number;
    fps: number;
    videoW: number;
    videoH: number;
    w: number;
    h: number;
    scale: number;
    align: number;
    custom: number;
    v: number;
  };
}

export interface GiftEffectInfo {
  web_mp4: string;
  web_mp4_json?: string;
  effect_config?: EffectConfig | null;
}

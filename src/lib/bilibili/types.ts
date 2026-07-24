export type ApiResponse<T = unknown> = {
  code: number;
  message: string;
  data?: T;
};

export type LoginProbeResult = {
  isLogin: boolean;
  uname?: string;
  mid?: number;
};

export type QRGenerateResult = {
  qrcode_key: string;
  url: string;
  image: string;
};

export type QRPollResult = {
  code: number;
  message: string;
  url: string;
  refresh_token: string;
  timestamp: number;
};

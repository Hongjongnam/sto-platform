/** 1234567 -> "1,234,567" */
export function units(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return BigInt(value).toLocaleString("ko-KR");
}

/** Cash amounts are stored in the token's smallest unit (6 decimals). */
export function cash(value: string | bigint | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("ko-KR")}${fraction ? `.${fraction}` : ""}`;
}

export function toCashUnits(whole: string): string {
  return (BigInt(whole) * 1_000_000n).toString();
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return "-";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "-";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", { hour12: false });
}

/** Decodes a bytes32 reason recorded on chain back into its text code. */
export function reasonText(bytes32: string | undefined): string {
  if (!bytes32 || !bytes32.startsWith("0x")) return bytes32 ?? "";
  let text = "";
  for (let i = 2; i < bytes32.length; i += 2) {
    const code = Number.parseInt(bytes32.slice(i, i + 2), 16);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return /^[\x20-\x7e]+$/.test(text) ? text : bytes32;
}

export const INVESTOR_TYPES = ["일반투자자", "적격투자자", "전문투자자"];

export const OPERATION_LABELS: Record<string, string> = {
  MINT: "발행",
  BURN: "소각",
  PAUSE: "거래 정지",
  UNPAUSE: "거래 재개",
  FREEZE_ADDRESS: "계좌 동결",
  UNFREEZE_ADDRESS: "계좌 동결 해제",
  FREEZE_PARTIAL: "수량 동결",
  UNFREEZE_PARTIAL: "수량 동결 해제",
  FORCED_TRANSFER: "강제이전",
  RECOVERY: "지갑 복구",
  SET_REGISTERED_SUPPLY: "등록 총량 변경",
};

export const EVENT_LABELS: Record<string, string> = {
  Transfer: "잔고 이동",
  Issued: "발행",
  Redeemed: "소각·상환",
  AddressFrozen: "계좌 동결 변경",
  TokensFrozen: "수량 동결",
  TokensUnfrozen: "수량 동결 해제",
  ForcedTransfer: "강제이전",
  RecoverySuccess: "지갑 복구",
  PauseStateChanged: "거래 정지 상태 변경",
  RegisteredSupplySet: "등록 총량 변경",
  IdentityRegistered: "신원 등록",
  IdentityRevoked: "신원 철회",
  TradeCreated: "체결 등록",
  TradeSettled: "결제 완료",
  TradeCancelled: "체결 취소",
  DistributionCreated: "배당 개설",
  DividendClaimed: "배당 지급",
  DistributionSwept: "미청구 배당 회수",
  RedemptionOpened: "상환 개설",
  RedemptionClosed: "상환 마감",
  Approval: "이전 한도 승인",
  RoleGranted: "권한 부여",
  RoleRevoked: "권한 회수",
};

/**
 * Plain-language explanations of contract rejections, written for someone new to
 * security tokens: what was blocked, and why a securities system must block it.
 */
export const ERROR_EXPLANATIONS: Record<string, { title: string; why: string }> = {
  NotVerified: {
    title: "신원이 확인되지 않은 지갑입니다",
    why: "증권은 KYC(고객확인)를 통과한 투자자만 보유할 수 있습니다. 받는 쪽이나 보내는 쪽 지갑이 신원 레지스트리에 유효하게 등록되어 있지 않아 컨트랙트가 거부했습니다.",
  },
  AccountFrozen: {
    title: "동결된 계좌입니다",
    why: "법원 명령이나 압류 등으로 계좌가 동결되면 그 계좌는 보내는 것도 받는 것도 할 수 없습니다. 동결은 집행 담당자가 다른 담당자의 승인을 받아 설정합니다.",
  },
  InsufficientFreeBalance: {
    title: "동결되지 않은 수량이 부족합니다",
    why: "보유 수량 중 일부가 동결되어 있으면 나머지(가용 잔고)만 움직일 수 있습니다. 가용 잔고 = 보유 수량 − 동결 수량.",
  },
  ComplianceRejected: {
    title: "투자 규칙을 위반하는 거래입니다",
    why: "컴플라이언스 모듈이 거부했습니다. 투자자 유형별 보유 한도를 넘거나, 보유자 수 상한에 걸리거나, 허용되지 않은 국가의 투자자인 경우입니다.",
  },
  RegisteredSupplyExceeded: {
    title: "등록된 총량을 넘는 발행입니다",
    why: "토큰 발행량은 전자등록된 총량을 넘을 수 없습니다. 외부 기관이 관리하는 총량과 온체인 총량이 어긋나지 않게 하는 장치입니다.",
  },
  RegisteredSupplyBelowTotalSupply: {
    title: "이미 발행된 수량보다 적게 등록할 수 없습니다",
    why: "등록 총량은 현재 발행된 총량 아래로 내릴 수 없습니다.",
  },
  TradeExists: {
    title: "이미 접수된 체결번호입니다",
    why: "같은 체결이 두 번 결제되면 안 됩니다. 체결번호의 해시를 거래 식별자로 써서 중복을 원천 차단합니다.",
  },
  TradeExpired: { title: "만료된 체결입니다", why: "체결에는 유효 기한이 있고, 기한이 지나면 결제할 수 없고 취소만 가능합니다." },
  InvalidSignature: {
    title: "당사자의 서명이 맞지 않습니다",
    why: "매도자와 매수자가 체결 조건(수량·가격 등)에 직접 서명해야 합니다. 서명한 조건과 제출된 조건이 다르면 거부됩니다.",
  },
  ERC20InsufficientBalance: { title: "잔고가 부족합니다", why: "보내려는 수량이나 금액보다 잔고가 적습니다." },
  ERC20InsufficientAllowance: {
    title: "결제 컨트랙트에 대한 승인 한도가 부족합니다",
    why: "DvP 결제는 당사자가 결제 컨트랙트에 자기 몫을 가져가도록 승인해 둔 범위 안에서만 실행됩니다.",
  },
  AlreadyClaimed: { title: "이미 받은 배당입니다", why: "배당은 지갑당 한 번만 청구할 수 있습니다." },
  NotEligible: {
    title: "지금은 받을 자격이 없습니다",
    why: "배당·상환은 청구 시점에 신원이 유효하고 계좌가 동결되지 않은 투자자만 받을 수 있습니다.",
  },
  NothingToClaim: { title: "받을 금액이 없습니다", why: "기준일 블록에 이 지갑의 잔고가 없었습니다. 기준일 이후에 산 수량은 배당 대상이 아닙니다." },
  ClaimWindowClosed: { title: "청구 기간이 끝났습니다", why: "마감 후 남은 금액은 발행인이 회수합니다." },
  ClaimWindowOpen: { title: "아직 청구 기간입니다", why: "미청구분은 마감 시각이 지난 뒤에만 회수할 수 있습니다." },
  RedemptionWindowOpen: { title: "아직 상환 기간입니다", why: "남은 예치금은 마감 시각이 지난 뒤에만 회수할 수 있습니다." },
  InvestorMismatch: {
    title: "같은 투자자의 지갑이 아닙니다",
    why: "지갑 복구는 분실 지갑과 새 지갑이 같은 투자자에게 속할 때만 가능합니다. 다른 사람에게 자산이 넘어가는 것을 막습니다.",
  },
  EnforcedPause: { title: "거래가 정지된 상태입니다", why: "정지 중에는 일반 전송·발행·소각이 모두 멈춥니다. 강제이전 같은 집행은 정지 중에도 가능합니다." },
  AccessControlUnauthorizedAccount: { title: "권한이 없는 계정입니다", why: "이 작업을 할 수 있는 역할이 그 계정에 부여되어 있지 않습니다." },
  DEPENDENCY_FAILED: { title: "앞 단계가 실패했습니다", why: "이 트랜잭션이 의존하는 앞선 트랜잭션이 실패해서 보내지 않았습니다." },
};

export function explain(errorCode: string | null | undefined): { title: string; why: string } {
  if (!errorCode) return { title: "알 수 없는 사유", why: "" };
  return ERROR_EXPLANATIONS[errorCode] ?? { title: errorCode, why: "컨트랙트가 이 호출을 거부했습니다." };
}

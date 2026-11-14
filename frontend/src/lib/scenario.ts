import { ApiError, type CorporateAction, type Investor, type LedgerState, type Operation, type Portfolio, type ReconReport, type Trade, type Transaction } from "./api";
import { cash, explain, shortAddress, toCashUnits, units } from "./format";

/** One line of a step's outcome. */
export interface Line {
  kind: "done" | "blocked" | "info";
  text: string;
  /** Contract error code, for blocked lines: rendered with its plain-language explanation. */
  code?: string;
}

/** What the scenario needs from the page: API access as either operator, and waiting. */
export interface Actions {
  call: <T>(path: string, options?: { body?: unknown; method?: string; as?: "requester" | "approver" }) => Promise<T>;
  waitForOperation: (id: string) => Promise<Operation>;
  waitForTransaction: (id: string) => Promise<Transaction>;
  waitUntil: <T>(read: () => Promise<T>, done: (value: T) => boolean) => Promise<T>;
}

/** Wallets the scenario creates in its first step and uses afterwards. */
export interface Cast {
  garam: { id: string; name: string; wallet: string; secondWallet?: string };
  narae: { id: string; name: string; wallet: string };
  daon: { id: string; name: string; wallet: string };
}

export interface Step {
  title: string;
  /** What happens, in one or two sentences. */
  what: string;
  /** Why a securities system works this way. */
  why: string;
  run: (actions: Actions, cast: Partial<Cast>) => Promise<Line[]>;
}

const done = (text: string): Line => ({ kind: "done", text });
const info = (text: string): Line => ({ kind: "info", text });
const blocked = (text: string, code?: string | null): Line => ({ kind: "blocked", text, code: code ?? undefined });

async function evidence(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function randomAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Files an operation and waits for the chain. Operations that need approval are approved by the second operator. */
async function operate(actions: Actions, type: string, params: Record<string, string>, reasonCode: string, document?: string): Promise<Operation> {
  const created = await actions.call<Operation>("/operations", {
    as: "requester",
    body: { type, params, reasonCode, ...(document ? { evidenceHash: await evidence(document) } : {}) },
  });
  if (created.needsApproval) await actions.call(`/operations/${created.id}/approve`, { as: "approver", body: { note: "근거 문서 확인" } });
  return actions.waitForOperation(created.id);
}

async function transfer(actions: Actions, from: string, to: string, amount: string): Promise<Transaction> {
  const { transactionId } = await actions.call<{ transactionId: string }>(`/wallets/${from}/transfers`, { as: "requester", body: { to, amount } });
  return actions.waitForTransaction(transactionId);
}

const portfolio = (actions: Actions, wallet: string) => actions.call<Portfolio>(`/wallets/${wallet}/portfolio`, { as: "requester" });

function expectRejected(result: { status?: string; errorCode: string | null } | Operation, attempt: string): Line {
  const execution = "execution" in result ? result.execution : result;
  if (execution?.status === "FAILED") return blocked(attempt, execution.errorCode);
  return info(`${attempt} — 예상과 달리 거부되지 않았습니다.`);
}

export const STEPS: Step[] = [
  {
    title: "투자자 등록 (KYC)",
    what: "가상의 투자자 세 명을 등록합니다. 각자 지갑이 만들어지고, KYC 기관 역할의 키가 서명한 신원 증명이 온체인 신원 레지스트리에 기록됩니다.",
    why: "증권은 아무나 보유할 수 없습니다. 고객확인(KYC)을 통과한 투자자의 지갑만 증권을 받을 수 있게, 컨트랙트가 전송 때마다 이 레지스트리를 확인합니다.",
    run: async (actions, cast) => {
      const suffix = Math.floor(100 + Math.random() * 900);
      const create = (name: string, investorType: number) =>
        actions.call<Investor>("/investors", { as: "requester", body: { name: `${name}-${suffix}`, country: 410, investorType } });
      const created = [await create("김가람", 0), await create("이나래", 0), await create("박다온", 1)];
      const verified = await Promise.all(
        created.map((investor) =>
          actions.waitUntil(
            () => actions.call<Investor>(`/investors/${investor.id}`, { as: "requester" }),
            (latest) => latest.wallets.every((wallet) => wallet.kycStatus !== "PENDING"),
          ),
        ),
      );
      const [garam, narae, daon] = verified.map((investor) => ({ id: investor.id, name: investor.name, wallet: investor.wallets[0].address }));
      Object.assign(cast, { garam, narae, daon });
      return [
        ...verified.map((investor) => done(`${investor.name} · ${investor.investorType === 1 ? "적격투자자" : "일반투자자"} · 지갑 ${shortAddress(investor.wallets[0].address)} · 신원 등록 완료`)),
        info("이름 같은 개인정보는 체인에 올라가지 않습니다. 체인에는 뜻을 알 수 없는 투자자 식별자와 유효 기한만 기록됩니다."),
      ];
    },
  },
  {
    title: "발행",
    what: "등록 총량을 확보한 뒤 김가람에게 500단위, 이나래에게 100단위를 발행합니다. 이어서 일부러 규칙을 어기는 발행 두 건을 시도합니다.",
    why: "발행량은 전자등록된 총량을 넘을 수 없고, 신원이 확인되지 않은 지갑이나 보유 한도를 넘는 투자자에게는 발행되지 않습니다. 이런 규칙을 사람이 아니라 컨트랙트가 강제합니다.",
    run: async (actions, cast) => {
      const lines: Line[] = [];
      const state = await actions.call<LedgerState>("/ledger/state", { as: "requester" });
      const needed = BigInt(state.totalSupply) + 5_000n;
      if (BigInt(state.registeredSupply) < needed) {
        await operate(actions, "SET_REGISTERED_SUPPLY", { amount: (needed + 100_000n).toString() }, "REGISTRATION", "전자등록 변경 통지서");
        lines.push(done(`등록 총량을 ${units(needed + 100_000n)}로 변경 (요청 담당자가 올리고 승인 담당자가 승인)`));
      }
      await operate(actions, "MINT", { to: cast.garam!.wallet, amount: "500" }, "PRIMARY_ISSUANCE");
      await operate(actions, "MINT", { to: cast.narae!.wallet, amount: "100" }, "PRIMARY_ISSUANCE");
      lines.push(done(`${cast.garam!.name}에게 500단위, ${cast.narae!.name}에게 100단위 발행`));

      const stranger = randomAddress();
      lines.push(expectRejected(await operate(actions, "MINT", { to: stranger, amount: "10" }, "PRIMARY_ISSUANCE"), `등록되지 않은 지갑 ${shortAddress(stranger)}에 10단위 발행 시도`));
      lines.push(expectRejected(await operate(actions, "MINT", { to: cast.narae!.wallet, amount: "1000" }, "ADDITIONAL_ISSUANCE"), `${cast.narae!.name}(일반투자자, 한도 1,000)에게 1,000단위 추가 발행 시도`));
      return lines;
    },
  },
  {
    title: "투자자 간 전송",
    what: "김가람이 이나래에게 50단위를 보냅니다. 그다음 등록되지 않은 지갑으로 보내 봅니다.",
    why: "발행할 때만이 아니라 투자자끼리 주고받을 때도 같은 검사를 거칩니다. 증권이 신원이 확인되지 않은 사람에게 흘러가는 길을 원천적으로 막는 것입니다.",
    run: async (actions, cast) => {
      const sent = await transfer(actions, cast.garam!.wallet, cast.narae!.wallet, "50");
      const stranger = randomAddress();
      const refused = await transfer(actions, cast.garam!.wallet, stranger, "1");
      const [garam, narae] = await Promise.all([portfolio(actions, cast.garam!.wallet), portfolio(actions, cast.narae!.wallet)]);
      return [
        sent.status === "CONFIRMED" ? done(`${cast.garam!.name} → ${cast.narae!.name} 50단위 전송`) : blocked("전송이 거부되었습니다", sent.errorCode),
        expectRejected(refused, `${cast.garam!.name} → 등록되지 않은 지갑 ${shortAddress(stranger)} 1단위 전송 시도`),
        info(`현재 잔고: ${cast.garam!.name} ${units(garam.balance)} · ${cast.narae!.name} ${units(narae.balance)}`),
      ];
    },
  },
  {
    title: "수량 동결과 두 사람 원칙",
    what: "법원 명령을 근거로 김가람의 보유 수량 중 400단위를 동결합니다. 요청한 담당자가 스스로 승인해 보려 하고, 그 뒤 다른 담당자가 승인합니다.",
    why: "보유자의 뜻과 무관하게 자산을 묶는 강한 권한이므로 한 사람이 혼자 실행할 수 없게 합니다. 동결된 수량은 움직일 수 없고, 나머지만 거래할 수 있습니다.",
    run: async (actions, cast) => {
      const lines: Line[] = [];
      const created = await actions.call<Operation>("/operations", {
        as: "requester",
        body: { type: "FREEZE_PARTIAL", params: { account: cast.garam!.wallet, amount: "400" }, reasonCode: "COURT_ORDER", evidenceHash: await evidence("법원 가압류 결정문") },
      });
      lines.push(done("요청 담당자가 수량 동결 요청을 올림 (근거 문서의 해시가 함께 기록됨)"));
      try {
        await actions.call(`/operations/${created.id}/approve`, { as: "requester" });
        lines.push(info("요청자가 스스로 승인하는 것이 막히지 않았습니다."));
      } catch (error) {
        lines.push(blocked(`요청 담당자가 자기 요청을 직접 승인 시도 → 서버가 거부 (${error instanceof ApiError ? error.status : "오류"})`));
      }
      await actions.call(`/operations/${created.id}/approve`, { as: "approver", body: { note: "결정문 확인" } });
      await actions.waitForOperation(created.id);
      lines.push(done("승인 담당자가 승인 → 체인에 반영"));

      const state = await portfolio(actions, cast.garam!.wallet);
      lines.push(info(`${cast.garam!.name}: 보유 ${units(state.balance)} · 동결 ${units(state.frozen)} · 거래 가능 ${units(state.free)}`));
      lines.push(expectRejected(await transfer(actions, cast.garam!.wallet, cast.narae!.wallet, "100"), `${cast.garam!.name}이 거래 가능 수량보다 많은 100단위 전송 시도`));
      return lines;
    },
  },
  {
    title: "DvP 결제",
    what: "박다온에게 테스트 현금을 지급한 뒤, 김가람이 박다온에게 30단위를 3,000 USDC에 파는 체결을 접수하고 결제합니다. 같은 체결번호를 한 번 더 접수해 봅니다.",
    why: "증권을 넘겼는데 돈을 못 받거나, 돈을 냈는데 증권을 못 받는 일이 없어야 합니다. 두 이동을 한 트랜잭션에 묶어 둘 다 일어나거나 둘 다 일어나지 않게 합니다. 같은 체결이 두 번 결제되는 것도 체결번호로 막습니다.",
    run: async (actions, cast) => {
      const { outboxId } = await actions.call<{ outboxId: string }>(`/wallets/${cast.daon!.wallet}/cash`, { as: "requester", body: { amount: toCashUnits("5000") } });
      await actions.waitForTransaction(outboxId);
      const before = await portfolio(actions, cast.garam!.wallet);

      const tradeNo = `DEMO-${Date.now()}`;
      const report = { tradeNo, seller: cast.garam!.wallet, buyer: cast.daon!.wallet, quantity: "30", price: toCashUnits("3000") };
      const created = await actions.call<Trade>("/trades", { as: "requester", body: report });
      const settled = await actions.waitUntil(
        () => actions.call<Trade>(`/trades/${created.id}`, { as: "requester" }),
        (trade) => trade.status !== "PENDING",
      );
      const again = await actions.call<Trade>("/trades", { as: "requester", body: { ...report, quantity: "999" } });
      const [seller, buyer] = await Promise.all([portfolio(actions, cast.garam!.wallet), portfolio(actions, cast.daon!.wallet)]);

      return [
        done(`${cast.daon!.name}에게 테스트 현금 5,000 USDC 지급`),
        settled.status === "SETTLED" ? done(`체결 ${tradeNo} 결제 완료 — 증권 30단위와 대금 3,000 USDC가 같은 트랜잭션에서 맞교환됨`) : blocked(`결제 실패 (${settled.failure?.step})`, settled.failure?.errorCode),
        info(`${cast.garam!.name}: 증권 ${units(before.balance)} → ${units(seller.balance)}, 현금 ${cash(before.cash)} → ${cash(seller.cash)} USDC`),
        info(`${cast.daon!.name}: 증권 ${units(buyer.balance)}, 현금 ${cash(buyer.cash)} USDC`),
        blocked(`같은 체결번호를 수량 999로 다시 접수 → 새 결제 없이 기존 건(수량 ${again.quantity})이 그대로 반환됨`),
      ];
    },
  },
  {
    title: "배당",
    what: "6,000 USDC의 배당을 개설하고 김가람과 이나래가 청구합니다. 김가람이 한 번 더 청구해 봅니다.",
    why: "배당은 기준 시점(기준 블록)의 보유 비율대로 나눕니다. 발행인이 모두에게 일괄 송금하는 대신 투자자가 각자 청구해 받아 가므로, 보유자가 아무리 많아도 한 건의 실패가 전체 지급을 막지 않습니다.",
    run: async (actions, cast) => {
      const opened = await actions.call<CorporateAction>("/dividends", { as: "requester", body: { totalAmount: toCashUnits("6000"), claimDays: 30 } });
      await actions.waitUntil(
        () => actions.call<CorporateAction>(`/dividends/${opened.id}`, { as: "requester" }),
        (action) => action.status !== "OPENING",
      );
      const claim = async (wallet: string, expected: number) => {
        await actions.call(`/dividends/${opened.id}/claims`, { as: "requester", body: { wallet } });
        return actions.waitUntil(
          () => actions.call<CorporateAction>(`/dividends/${opened.id}`, { as: "requester" }),
          (action) => action.claims.length >= expected && action.claims.every((item) => item.status === "CONFIRMED" || item.status === "FAILED"),
        );
      };
      await claim(cast.garam!.wallet, 1);
      await claim(cast.narae!.wallet, 2);
      const final = await claim(cast.garam!.wallet, 3);
      const paid = (wallet: string) => final.claims.find((item) => item.wallet === wallet && item.status === "CONFIRMED")?.paid;
      const second = final.claims[2];
      return [
        done(`배당 6,000 USDC 개설 (기준 블록 ${units(final.recordBlock)})`),
        done(`${cast.garam!.name} 청구 → ${cash(paid(cast.garam!.wallet))} USDC 수령`),
        done(`${cast.narae!.name} 청구 → ${cash(paid(cast.narae!.wallet))} USDC 수령`),
        info("받는 금액은 기준 블록 시점의 보유 수량 ÷ 전체 발행량에 비례합니다. 다른 방문자가 발행해 둔 수량이 있으면 그만큼 비율이 줄어듭니다."),
        second?.status === "FAILED" ? blocked(`${cast.garam!.name}이 같은 배당을 다시 청구`, second.errorCode) : info("두 번째 청구가 거부되지 않았습니다."),
      ];
    },
  },
  {
    title: "계좌 동결과 강제이전",
    what: "이나래의 계좌 전체를 동결하고, 이나래가 전송을 시도합니다. 그 뒤 법원 명령에 따라 이나래의 20단위를 박다온에게 강제로 옮기고 동결을 풉니다.",
    why: "일반 토큰에는 없는 기능입니다. 증권은 법적 권리이므로 압류, 상속, 법원 판결을 장부에 반영할 수 있어야 합니다. 대신 누가 어떤 근거로 했는지 체인에 남기고, 받는 쪽은 반드시 신원이 확인된 지갑이어야 합니다.",
    run: async (actions, cast) => {
      await operate(actions, "FREEZE_ADDRESS", { account: cast.narae!.wallet }, "COURT_ORDER", "법원 압류 명령");
      const refused = await transfer(actions, cast.narae!.wallet, cast.garam!.wallet, "10");
      const forced = await operate(actions, "FORCED_TRANSFER", { from: cast.narae!.wallet, to: cast.daon!.wallet, amount: "20" }, "COURT_ORDER", "법원 전부명령");
      await operate(actions, "UNFREEZE_ADDRESS", { account: cast.narae!.wallet }, "COURT_ORDER", "법원 압류 해제 결정");
      const [narae, daon] = await Promise.all([portfolio(actions, cast.narae!.wallet), portfolio(actions, cast.daon!.wallet)]);
      return [
        done(`${cast.narae!.name} 계좌 동결 (요청 → 승인)`),
        expectRejected(refused, `동결된 ${cast.narae!.name} 계좌에서 10단위 전송 시도`),
        forced.execution?.status === "CONFIRMED" ? done(`동결 중인 계좌에서 20단위를 ${cast.daon!.name}에게 강제이전 (요청 → 승인)`) : blocked("강제이전 실패", forced.execution?.errorCode),
        done(`${cast.narae!.name} 계좌 동결 해제`),
        info(`현재 잔고: ${cast.narae!.name} ${units(narae.balance)} · ${cast.daon!.name} ${units(daon.balance)}`),
      ];
    },
  },
  {
    title: "지갑 복구",
    what: "김가람이 지갑 키를 잃어버렸다고 가정합니다. 같은 투자자 이름으로 새 지갑을 등록하고, 분실 지갑의 잔고를 새 지갑으로 옮깁니다.",
    why: "일반 토큰은 키를 잃으면 자산도 잃습니다. 증권은 권리자가 명확하므로 본인 확인을 거쳐 복구할 수 있어야 합니다. 동결되어 있던 수량은 새 지갑에서도 그대로 동결되고, 다른 투자자의 지갑으로는 옮길 수 없습니다.",
    run: async (actions, cast) => {
      const withSecond = await actions.call<Investor>(`/investors/${cast.garam!.id}/wallets`, { as: "requester", method: "POST" });
      const ready = await actions.waitUntil(
        () => actions.call<Investor>(`/investors/${withSecond.id}`, { as: "requester" }),
        (latest) => latest.wallets.every((wallet) => wallet.kycStatus !== "PENDING"),
      );
      const newWallet = ready.wallets[1].address;
      cast.garam!.secondWallet = newWallet;
      const holdersBefore = (await actions.call<LedgerState>("/ledger/state", { as: "requester" })).holders;

      const wrong = await operate(actions, "RECOVERY", { lostWallet: cast.garam!.wallet, newWallet: cast.narae!.wallet }, "LOST_KEY", "분실 신고서");
      const recovered = await operate(actions, "RECOVERY", { lostWallet: cast.garam!.wallet, newWallet }, "LOST_KEY", "분실 신고서 및 본인 확인서");
      const [lost, fresh] = await Promise.all([portfolio(actions, cast.garam!.wallet), portfolio(actions, newWallet)]);
      const holdersAfter = (await actions.call<LedgerState>("/ledger/state", { as: "requester" })).holders;
      return [
        done(`${cast.garam!.name}의 새 지갑 ${shortAddress(newWallet)} 등록 (같은 투자자 식별자로 연결)`),
        expectRejected(wrong, `분실 지갑의 잔고를 다른 투자자(${cast.narae!.name})의 지갑으로 복구 시도`),
        recovered.execution?.status === "CONFIRMED" ? done("분실 지갑 → 새 지갑으로 전체 잔고 이전 (요청 → 승인)") : blocked("복구 실패", recovered.execution?.errorCode),
        info(`분실 지갑: 보유 ${units(lost.balance)} · 새 지갑: 보유 ${units(fresh.balance)}, 동결 ${units(fresh.frozen)} (동결 상태도 함께 옮겨짐)`),
        info(`보유 투자자 수: ${holdersBefore}명 → ${holdersAfter}명 (같은 사람의 지갑 사이 이동이라 변하지 않음)`),
      ];
    },
  },
  {
    title: "장부 대사와 복구",
    what: "회사 내부 장부와 블록체인을 비교합니다. 그다음 내부 장부의 잔고 하나를 일부러 틀리게 만들고, 대사가 찾아내는지 확인한 뒤 체인 이벤트를 다시 재생해 복구합니다.",
    why: "회사는 조회와 업무 처리를 위해 내부 데이터베이스에도 장부를 둡니다. 토큰증권에서는 블록체인이 법적 원본이므로, 둘이 어긋나면 고쳐야 하는 쪽은 언제나 내부 장부입니다.",
    run: async (actions) => {
      const run = () => actions.call<ReconReport>("/recon/run", { as: "requester", method: "POST" });
      const first = await run();
      const corrupted = await actions.call<{ wallet: string; addedToLedger: string }>("/demo/ledger/corrupt", { as: "requester", method: "POST" });
      const broken = await run();
      const found = broken.mismatches.find((mismatch) => mismatch.field === "balance" && mismatch.subject === corrupted.wallet);
      const rebuilt = await actions.call<{ events: number }>("/recon/rebuild", { as: "approver", method: "POST" });
      const repaired = await run();
      return [
        first.ok ? done(`대사 실행 (블록 ${units(first.blockNumber)} 기준, 지갑 ${first.walletsChecked}개) → 모든 항목 일치`) : info(`대사 실행 → 불일치 ${first.mismatches.length}건`),
        info(`내부 장부에서 ${shortAddress(corrupted.wallet)} 지갑의 잔고를 ${corrupted.addedToLedger}만큼 부풀림 (체인은 건드리지 않음)`),
        found ? blocked(`대사 재실행 → 불일치 ${broken.mismatches.length}건 발견. 해당 지갑: 장부 ${units(found.ledger)} · 체인 ${units(found.chain)}`) : info("불일치를 찾지 못했습니다."),
        done(`체인 이벤트 ${units(rebuilt.events)}건을 처음부터 다시 재생해 내부 장부 복구 (승인 담당자 권한)`),
        repaired.ok ? done("대사 재실행 → 다시 모든 항목 일치") : info(`대사 재실행 → 불일치 ${repaired.mismatches.length}건`),
      ];
    },
  },
];

export { explain };

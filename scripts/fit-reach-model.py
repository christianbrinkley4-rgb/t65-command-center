"""Fit the reach model on real outcomes, so the queue's weights stop being guesses.

Run this again whenever there is a few hundred more dials in the book. Re-pull
the grouped counts with the SQL at the bottom of this file, paste them into
ROWS, and re-fit. The coefficients go into scoreLead in lib/coach.ts.

WHAT IT FOUND THE FIRST TIME (Sept 2026, 1,996 dialed leads, 134 conversations)

  has a mobile          3.25x odds
  CLEC / unknown line   2.34x
  from a tracker list   1.55x
  from OSCR             1.58x
  turns 65 in 2027      1.14x
  home value 250-500k   0.74x
  home value over 500k  1.03x

Two of those changed the app. Unknown lines were scoring zero on the reasoning
that a competitive-carrier block could be either kind, and the fit says they
behave much closer to a mobile: that was 769 leads in the 1962 pile being
under-ranked out of false modesty. And home value does not predict reach at
all, despite being a queue tiebreaker and the filter the mailer geography is
chosen on. It may still predict what a sale is WORTH, which is a different
question this model does not answer.

WHAT IT CANNOT DO

Predict bookings. Only 9 leads in the book have an appointment row linked to
them, and nine events will not support a multivariate model no matter how it is
fitted. Anyone quoting one is quoting noise. Reach is the well-powered target
here and it is the one modelled.

Logistic regression on grouped binomial data, fitted by IRLS.

No sklearn in this environment, and it is not needed: the design matrix is
small and the fit is exact. Grouped form (n trials, k successes per cell) is
equivalent to per-row fitting and much cheaper.

Target: did this lead ever produce a real conversation. 141 events over 2,035
dialed leads. At the usual ten-events-per-predictor rule that supports about
fourteen coefficients; we use seven, so this is comfortably powered.
"""
import math

# line, value band, cohort, source, n trials, k reached
ROWS = [
 ("mobile","band250_500","y2027","tracker",213,23),("landline","band250_500","y2027","tracker",144,5),
 ("mobile","band250_500","y2026","tracker",120,15),("mobile","band250_500","y2026","bought_t65",102,6),
 ("unknown","band250_500","y2027","tracker",98,8),("mobile","under250","y2026","bought_t65",84,3),
 ("landline","band250_500","y2026","tracker",80,0),("mobile","over500","y2027","tracker",76,11),
 ("mobile","band250_500","y2027","bought_t65",69,3),("landline","under250","y2026","bought_t65",58,2),
 ("landline","band250_500","y2027","bought_t65",55,0),("landline","over500","y2027","tracker",54,3),
 ("unknown","band250_500","y2026","tracker",54,2),("unknown","band250_500","y2027","bought_t65",52,3),
 ("landline","band250_500","y2026","bought_t65",52,4),("unknown","under250","y2026","bought_t65",46,3),
 ("mobile","unpriced","y2026","bought_t65",42,2),("landline","over500","y2026","tracker",40,0),
 ("unknown","over500","y2027","tracker",39,2),("mobile","over500","y2026","tracker",38,2),
 ("mobile","unpriced","y2026","tracker",32,1),("unknown","band250_500","y2026","bought_t65",31,0),
 ("mobile","under250","y2027","bought_t65",30,2),("unknown","over500","y2026","tracker",26,5),
 ("landline","under250","y2027","bought_t65",24,0),("unknown","unpriced","y2026","tracker",22,0),
 ("landline","unpriced","y2026","bought_t65",19,0),("unknown","under250","y2027","bought_t65",17,1),
 ("unknown","unpriced","y2026","bought_t65",16,0),("landline","band250_500","y2027","oscr",15,0),
 ("landline","unpriced","y2027","bought_t65",14,0),("unknown","band250_500","y2027","oscr",12,0),
 ("landline","unpriced","y2026","tracker",12,0),("landline","band250_500","y2026","oscr",12,0),
 ("landline","under250","y2026","tracker",11,0),("mobile","band250_500","y2026","oscr",11,0),
 ("mobile","unpriced","y2027","tracker",11,3),("unknown","unpriced","y2027","bought_t65",10,0),
 ("unknown","unpriced","y2027","tracker",10,1),("mobile","unpriced","y2027","bought_t65",10,0),
 ("landline","unpriced","y2027","tracker",10,0),("unknown","over500","y2027","oscr",10,3),
 ("unknown","band250_500","y2026","oscr",9,2),("unknown","over500","y2027","bought_t65",8,1),
 ("mobile","band250_500","y2027","other",8,6),("landline","over500","y2026","bought_t65",8,0),
 ("unknown","under250","y2027","oscr",8,1),("mobile","under250","y2026","tracker",8,2),
 ("mobile","band250_500","y2027","oscr",7,0),("landline","under250","y2027","tracker",7,0),
 ("landline","under250","y2027","oscr",7,0),("landline","over500","y2027","bought_t65",7,0),
 ("landline","over500","y2027","oscr",7,0),("mobile","over500","y2026","oscr",6,1),
 ("mobile","under250","y2026","oscr",5,2),("unknown","under250","y2027","tracker",5,1),
 ("mobile","over500","y2027","other",5,4),("unknown","under250","y2026","oscr",5,0),
 ("unknown","under250","y2026","tracker",5,1),
]

# Reference levels: line=landline, val=under250, cohort=y2026, src=bought_t65.
NAMES = ["intercept","line_mobile","line_unknown","val_250_500","val_over500","val_unpriced","cohort_y2027","src_tracker","src_oscr","src_other"]

def design(r):
    line,val,coh,src,_,_ = r
    return [1.0,
            1.0 if line=="mobile" else 0.0,
            1.0 if line=="unknown" else 0.0,
            1.0 if val=="band250_500" else 0.0,
            1.0 if val=="over500" else 0.0,
            1.0 if val=="unpriced" else 0.0,
            1.0 if coh=="y2027" else 0.0,
            1.0 if src=="tracker" else 0.0,
            1.0 if src=="oscr" else 0.0,
            1.0 if src=="other" else 0.0]

X = [design(r) for r in ROWS]
N = [r[4] for r in ROWS]
K = [r[5] for r in ROWS]
p = len(NAMES)

def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[piv][c]) < 1e-12: M[piv][c] += 1e-9
        M[c], M[piv] = M[piv], M[c]
        for r in range(n):
            if r == c: continue
            f = M[r][c] / M[c][c]
            for k in range(c, n + 1): M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]

# IRLS with a small ridge, because several cells are all-zero successes and
# would otherwise send a coefficient to negative infinity.
RIDGE = 1.0
beta = [0.0] * p
for _ in range(200):
    H = [[RIDGE if i == j else 0.0 for j in range(p)] for i in range(p)]
    g = [-RIDGE * beta[i] for i in range(p)]
    for xi, n, k in zip(X, N, K):
        eta = sum(b * x for b, x in zip(beta, xi))
        mu = 1 / (1 + math.exp(-max(-30, min(30, eta))))
        w = n * mu * (1 - mu)
        resid = k - n * mu
        for i in range(p):
            g[i] += xi[i] * resid
            for j in range(p): H[i][j] += w * xi[i] * xi[j]
    step = solve(H, g)
    beta = [b + s for b, s in zip(beta, step)]
    if max(abs(s) for s in step) < 1e-9: break

print(f"fitted on {sum(N)} dialed leads, {sum(K)} reached ({100*sum(K)/sum(N):.1f}%)\n")
print(f"{'term':16} {'coef':>8} {'odds x':>8}")
for name, b in zip(NAMES, beta):
    print(f"{name:16} {b:8.3f} {math.exp(b):8.2f}")

base = 1 / (1 + math.exp(-beta[0]))
print(f"\nbaseline cell (landline, under250k, turns 65 in 2026, bought T65 list): {100*base:.1f}% reach")

def prob(line, val, coh, src):
    xi = design((line, val, coh, src, 0, 0))
    eta = sum(b * x for b, x in zip(beta, xi))
    return 1 / (1 + math.exp(-eta))

print("\npredicted reach rate:")
for line in ("mobile", "unknown", "landline"):
    for val in ("over500", "band250_500", "under250"):
        print(f"  {line:9} {val:12} 2027 tracker  {100*prob(line,val,'y2027','tracker'):5.1f}%")

# The query that produces ROWS. Run it against the project, paste the result in.
REFRESH_SQL = """
with d as (
  select
    case when coalesce(l.phone_type,'')='mobile' or coalesce(l.phone2_type,'')='mobile' then 'mobile'
         when coalesce(l.phone_type,'')='fixed_line' then 'landline' else 'unknown' end line,
    case when l.home_value is null then 'unpriced'
         when l.home_value < 250000 then 'under250'
         when l.home_value <= 500000 then 'band250_500' else 'over500' end val,
    case when l.birthday is null then 'nobday'
         when l.birthday between '1961-01-01' and '1961-12-31' then 'y2026'
         when l.birthday between '1962-01-01' and '1962-12-31' then 'y2027'
         else 'other' end cohort,
    case when l.source ilike 'TrackerLeads%' then 'tracker'
         when l.source ilike 'T65%' then 'bought_t65'
         when l.source ilike 'OSCR%' then 'oscr' else 'other' end src,
    (exists (select 1 from activity_log a where a.lead_id=l.id and a.activity_type='Call'
       and a.outcome ~* 'talked|spoke to|answered|interested|not ready|sent info|sold|appointment'
       and a.outcome !~* 'wrong person'))::int reached
  from leads l
  where exists (select 1 from activity_log a where a.lead_id=l.id and a.activity_type='Call')
)
select line, val, cohort, src, count(*) n, sum(reached) k
from d group by 1,2,3,4 having count(*) >= 5 order by n desc;
"""

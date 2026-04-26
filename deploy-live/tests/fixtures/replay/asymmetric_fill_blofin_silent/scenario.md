# Asymmetric fill: MEXC fills, BloFin "succeeds" but no leg appears

Reproduces P1058 / P1130. The bot placed orders on MEXC and BLOFIN. MEXC
filled. BLOFIN returned status=filled but filledSize=0 (the silent-failure
mode the BloFin normalizer is designed to catch). Bot state should never
have committed the BLOFIN leg, but if it did, reconciler will catch the
orphan.

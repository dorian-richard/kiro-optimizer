"""Payment gateway adapters."""
import logging
from decimal import Decimal
from .models import Charge, Refund as RefundModel

MAX_RETRIES = 3
_private_flag = True
logger = logging.getLogger(__name__)


class PaymentGateway(BaseGateway):
    """Talks to the payment provider. Thread-safe."""

    timeout = 30

    def __init__(self, client):
        self.client = client
        self._cache = {}

    @retry(times=MAX_RETRIES)
    def charge(self, amount: Decimal, token: str) -> Charge:
        """Charge a card token.

        Returns the created charge.
        """
        local_value = amount * 2
        return self.client.post_charge(amount, token)

    def _sign(self, payload):
        return payload

    class Config:
        retries = 2


@cached
def refund_charge(gateway: PaymentGateway, charge_id: str) -> RefundModel:
    """Refund a previous charge."""
    result = gateway.charge(Decimal("0"), charge_id)
    return RefundModel(result)


def _internal():
    pass

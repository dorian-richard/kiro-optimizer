class Charge:
    pass


class Refund:
    def __init__(self, charge):
        self.charge = charge

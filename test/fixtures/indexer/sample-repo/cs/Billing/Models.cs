namespace Acme.Billing;

public record Invoice(string Email, decimal Total);

public interface IMailer
{
    void Deliver(string to, string body);
}

public struct Money
{
    public decimal Amount;
}

using System;
using System.Collections.Generic;

namespace Acme.Billing
{
    /// <summary>
    /// Creates and sends invoices.
    /// </summary>
    public class InvoiceService : IInvoiceService
    {
        private readonly IMailer _mailer;
        public int Count { get; private set; }
        public const int MaxLines = 100;

        public InvoiceService(IMailer mailer)
        {
            _mailer = mailer;
        }

        /// <summary>Sends the invoice to the customer.</summary>
        public void Send(Invoice invoice)
        {
            var body = Render(invoice);
            _mailer.Deliver(invoice.Email, body);
        }

        private string Render(Invoice invoice) => invoice.ToString();
    }

    public interface IInvoiceService
    {
        void Send(Invoice invoice);
    }
}

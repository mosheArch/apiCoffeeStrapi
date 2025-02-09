const Stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)
const { createCoreController } = require("@strapi/strapi").factories
const sgMail = require("@sendgrid/mail")

// Configurar SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY)

module.exports = createCoreController("api::orden.orden", ({ strapi }) => ({
    async paymentOrder(ctx) {
        try {
            console.log("Headers:", JSON.stringify(ctx.request.headers, null, 2))
            console.log("Method:", ctx.request.method)
            console.log("URL:", ctx.request.url)
            console.log("Raw Body:", ctx.request.body)
            console.log("Query:", ctx.query)

            // Intenta obtener el cuerpo de la solicitud de diferentes maneras
            let bodyData
            if (ctx.request.body) {
                bodyData = ctx.request.body
            } else if (ctx.req && ctx.req.body) {
                bodyData = ctx.req.body
            } else {
                // Si todo lo demás falla, intenta leer el cuerpo como una cadena
                bodyData = await new Promise((resolve) => {
                    let body = ""
                    ctx.req.on("data", (chunk) => {
                        body += chunk.toString()
                    })
                    ctx.req.on("end", () => {
                        try {
                            resolve(JSON.parse(body))
                        } catch (e) {
                            console.error("Error parsing request body:", e)
                            resolve(null)
                        }
                    })
                })
            }

            console.log("Parsed Body Data:", bodyData)

            if (!bodyData || !bodyData.data) {
                return ctx.badRequest("El cuerpo de la solicitud está vacío o mal formateado")
            }

            const { payment_method, direccionEnvio } = bodyData.data
            const user = ctx.state.user

            // Verificaciones individuales
            if (!user) return ctx.unauthorized("Usuario no autenticado")
            if (!payment_method) return ctx.badRequest("Falta el payment_method")
            if (!direccionEnvio) return ctx.badRequest("Falta la dirección de envío")

            // Obtener los productos del carrito del usuario
            const cartItems = await strapi.db.query("api::carrito.carrito").findMany({
                where: { user: user.id },
                populate: ["producto"],
            })

            if (!cartItems || cartItems.length === 0) {
                return ctx.badRequest("El carrito está vacío")
            }

            console.log("Cart Items:", JSON.stringify(cartItems, null, 2))

            // Calcular el total de la orden y preparar los productos
            let totalPayment = 0
            const productos = cartItems
                .map((item) => {
                    if (item.producto && typeof item.cantidad === "number" && item.cantidad > 0) {
                        const { id, nombre, precio } = item.producto
                        const cantidad = item.cantidad
                        const subtotal = precio * cantidad
                        totalPayment += subtotal
                        return { id, nombre, precio, cantidad, subtotal }
                    } else {
                        console.warn("Invalid cart item:", item)
                        return null
                    }
                })
                .filter(Boolean)

            console.log("Total calculado:", totalPayment)
            console.log("Productos:", productos)

            if (productos.length === 0) {
                return ctx.badRequest("No hay productos válidos en el carrito")
            }

            if (isNaN(totalPayment) || totalPayment <= 0) {
                return ctx.badRequest("El total de la orden es inválido")
            }

            // Crear PaymentIntent con Stripe
            const paymentIntent = await Stripe.paymentIntents.create({
                amount: Math.round(totalPayment * 100),
                currency: "mxn",
                payment_method: payment_method,
                confirm: true,
                automatic_payment_methods: {
                    enabled: true,
                    allow_redirects: "never",
                },
                description: `Orden para ${user.nombres} ${user.apellidos}`,
            })

            console.log("PaymentIntent creado:", paymentIntent.id)

            if (paymentIntent.status !== "succeeded") {
                return ctx.badRequest("El pago no se pudo procesar correctamente")
            }

            // Crear la orden en Strapi
            const ordenData = {
                user: user.id,
                total: Math.round(totalPayment),
                idPago: paymentIntent.id,
                direccionEnvio,
                productos,
                estado: "pagada",
                fechaPago: new Date(),
                numeroOrden: `ORD-${Date.now()}`,
                metodoPago: payment_method,
                publishedAt: new Date(),
            }

            console.log("Datos de la orden a crear:", ordenData)

            const orden = await strapi.entityService.create("api::orden.orden", {
                data: ordenData,
            })

            // Vaciar el carrito del usuario
            for (const item of cartItems) {
                await strapi.entityService.delete("api::carrito.carrito", item.id)
            }

            // Enviar correo de confirmación
            await this.sendOrderConfirmationEmail(orden, user)

            return ctx.send({
                success: true,
                order: orden,
                paymentIntent: paymentIntent.id,
            })
        } catch (error) {
            console.error("Error detallado:", error)
            return ctx.badRequest(`Error processing payment: ${error.message}`)
        }
    },

    async sendOrderConfirmationEmail(order, user) {
        try {
            const msg = {
                to: user.email,
                from: "no-responder@clicafe.com", // Asegúrate de que este email esté verificado en SendGrid
                subject: "Confirmación de tu orden",
                text: `
          Hola ${user.nombres},
          
          Gracias por tu compra. Tu orden con número ${order.numeroOrden} ha sido confirmada.
          
          Detalles de la orden:
          ID de la orden: ${order.id}
          Número de orden: ${order.numeroOrden}
          Total: $${order.total}
          Estado: ${order.estado}
          Método de pago: ${order.metodoPago}
          Fecha de pago: ${order.fechaPago}
          
          Productos:
          ${order.productos.map((p) => `- ${p.nombre} x${p.cantidad}: $${p.subtotal}`).join("\n")}
          
          Te notificaremos cuando tu pedido esté listo para enviar.
          
          Saludos,
          Tu Tienda
        `,
                html: `
          <h2>Gracias por tu compra</h2>
          <p>Hola ${user.nombres},</p>
          <p>Tu orden con número ${order.numeroOrden} ha sido confirmada.</p>
          <h3>Detalles de la orden:</h3>
          <ul>
            <li>ID de la orden: ${order.id}</li>
            <li>Número de orden: ${order.numeroOrden}</li>
            <li>Total: $${order.total}</li>
            <li>Estado: ${order.estado}</li>
            <li>Método de pago: ${order.metodoPago}</li>
            <li>Fecha de pago: ${order.fechaPago}</li>
          </ul>
          <h3>Productos:</h3>
          <ul>
            ${order.productos.map((p) => `<li>${p.nombre} x${p.cantidad}: $${p.subtotal}</li>`).join("")}
          </ul>
          <p>Te notificaremos cuando tu pedido esté listo para enviar.</p>
          <p>Saludos,<br>Tu Tienda</p>
        `,
            }

            await sgMail.send(msg)
            console.log(`Correo de confirmación enviado para la orden ${order.numeroOrden}`)
        } catch (error) {
            console.error("Error al enviar el correo de confirmación:", error)
            if (error.response) {
                console.error("Error details:", error.response.body)
            }
        }
    },
}))


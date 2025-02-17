const Stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)
const { createCoreController } = require("@strapi/strapi").factories
const sgMail = require("@sendgrid/mail")

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

            // Obtener los elementos del carrito del usuario
            const cartItems = await strapi.db.query("api::carrito.carrito").findMany({
                where: { user: user.id },
                populate: ["producto"],
            })

            console.log("Cart Items:", JSON.stringify(cartItems, null, 2))

            if (!cartItems || cartItems.length === 0) {
                return ctx.badRequest("El carrito está vacío")
            }

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

    async updateOrderStatus(ctx) {
        try {
            const { id } = ctx.params

            console.log("Full context:", JSON.stringify(ctx, null, 2))
            console.log("Request body:", ctx.request.body)
            console.log("Request query:", ctx.query)
            console.log("Request headers:", ctx.request.headers)

            let data
            if (ctx.request.body && ctx.request.body.data) {
                data = ctx.request.body.data
            } else if (ctx.request.body) {
                data = ctx.request.body
            } else if (ctx.query && ctx.query.data) {
                data = JSON.parse(ctx.query.data)
            } else {
                console.log("No se pudo encontrar datos en el cuerpo de la solicitud")
                return ctx.badRequest("El cuerpo de la solicitud está vacío o mal formateado")
            }

            console.log("Parsed data:", data)

            const { estado, numeroGuia } = data

            console.log("Received update request:", { id, estado, numeroGuia })

            if (!id || !estado || !numeroGuia) {
                return ctx.badRequest("Faltan datos requeridos (id, estado, numeroGuia)")
            }

            const orden = await strapi.entityService.findOne("api::orden.orden", id, {
                populate: ["user"],
            })

            console.log("Orden obtenida:", JSON.stringify(orden, null, 2))

            if (!orden || !orden.user) {
                return ctx.notFound("Orden no encontrada o sin usuario asociado")
            }

            const updatedOrden = await strapi.entityService.update("api::orden.orden", id, {
                data: {
                    estado,
                    numeroGuia,
                },
                populate: ["user"],
            })

            console.log("Orden actualizada:", JSON.stringify(updatedOrden, null, 2))

            // Enviar correo de notificación de envío
            await this.sendShippingNotificationEmail(updatedOrden)

            return ctx.send({
                success: true,
                order: updatedOrden,
            })
        } catch (error) {
            console.error("Error al actualizar el estado de la orden:", error)
            return ctx.badRequest(`Error al actualizar el estado de la orden: ${error.message}`)
        }
    },

    async sendShippingNotificationEmail(order) {
        try {
            console.log("Orden recibida en sendShippingNotificationEmail:", JSON.stringify(order, null, 2))

            if (!order.user) {
                console.error("Error: La orden no tiene un usuario asociado")
                return
            }

            if (!order.user.email) {
                console.error("Error: El usuario asociado no tiene email", order.user)
                return
            }

            const msg = {
                to: order.user.email,
                from: "no-responder@clicafe.com",
                subject: "Tu pedido ha sido enviado",
                text: `
          Hola ${order.user.nombres || "Estimado cliente"},
          
          Tu pedido con número de orden ${order.numeroOrden} ha sido enviado.
          
          Número de guía: ${order.numeroGuia}
          
          Puedes usar este número de guía para rastrear tu paquete.
          
          Gracias por tu compra.
          
          Saludos,
          Tu Tienda
        `,
                html: `
          <h2>Tu pedido ha sido enviado</h2>
          <p>Hola ${order.user.nombres || "Estimado cliente"},</p>
          <p>Tu pedido con número de orden ${order.numeroOrden} ha sido enviado.</p>
          <p><strong>Número de guía:</strong> ${order.numeroGuia}</p>
          <p>Puedes usar este número de guía para rastrear tu paquete.</p>
          <p>Gracias por tu compra.</p>
          <p>Saludos,<br>Tu Tienda</p>
        `,
            }

            await sgMail.send(msg)
            console.log(`Correo de notificación de envío enviado para la orden ${order.numeroOrden}`)
        } catch (error) {
            console.error("Error al enviar el correo de notificación de envío:", error)
            if (error.response) {
                console.error("Error details:", error.response.body)
            }
        }
    },
}))

// Función auxiliar para leer el cuerpo de la solicitud manualmente
function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = ""
        req.on("data", (chunk) => {
            data += chunk
        })
        req.on("end", () => {
            resolve(data)
        })
        req.on("error", reject)
    })
}


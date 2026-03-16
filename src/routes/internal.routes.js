const express = require("express");
const { changeOrderStatus } = require("../services/order.service");
const router = express.Router();

/**
 * Rota para Gerenciar Status:
 * POST /order/ID_DO_PEDIDO/confirm  -> Aceita o pedido
 * POST /order/ID_DO_PEDIDO/ready    -> Marca como Pronto/Saiu para Entrega
 */
router.post("/order/:id/:action", async (req, res) => {
    const { id, action } = req.params;
    
    // Validação das ações permitidas pelo CardápioWeb
    if (!['confirm', 'ready'].includes(action)) {
        return res.status(400).json({ error: "Ação inválida. Use 'confirm' ou 'ready'." });
    }

    const result = await changeOrderStatus(id, action);
    
    if (result.ok) {
        return res.json({ 
            success: true, 
            message: `Pedido ${id} atualizado para ${action === 'confirm' ? 'Confirmado' : 'Pronto'}` 
        });
    }
    
    return res.status(401).json({ error: result.error });
});

module.exports = router;

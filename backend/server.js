// ========================================
// 🚀 NutriIA Backend Server
// ========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// 📋 MIDDLEWARE
// ========================================

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Para webhook do Stripe (precisa estar ANTES do express.json())
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================================
// 🏥 HEALTH CHECK
// ========================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: '🚀 NutriIA Backend está rodando!',
    timestamp: new Date().toISOString()
  });
});

// ========================================
// 🧮 CÁLCULO DE PLANO NUTRICIONAL
// ========================================

app.post('/api/calculate-plan', async (req, res) => {
  try {
    const { 
      name, gender, age, height, weight, targetWeight, 
      goal, activityLevel, dietType, restrictions 
    } = req.body;

    // Validação básica
    if (!age || !height || !weight || !goal || !activityLevel) {
      return res.status(400).json({ 
        error: 'Dados incompletos. Preencha todos os campos obrigatórios.' 
      });
    }

    // Cálculo TMB (Taxa Metabólica Basal) - Fórmula de Harris-Benedict
    let tmb;
    if (gender === 'male') {
      tmb = 88.362 + (13.397 * parseFloat(weight)) + (4.799 * parseFloat(height)) - (5.677 * parseFloat(age));
    } else {
      tmb = 447.593 + (9.247 * parseFloat(weight)) + (3.098 * parseFloat(height)) - (4.330 * parseFloat(age));
    }

    // Fator de atividade física
    const activityMultipliers = {
      sedentary: 1.2,    // Sedentário
      light: 1.375,      // Exercício leve (1-3x/semana)
      moderate: 1.55,    // Exercício moderado (3-5x/semana)
      intense: 1.725,    // Exercício intenso (6-7x/semana)
      veryIntense: 1.9   // Atleta profissional
    };

    const tdee = tmb * (activityMultipliers[activityLevel] || 1.2);

    // Ajuste calórico baseado no objetivo
    let targetCalories;
    let estimatedWeeks;
    
    switch(goal) {
      case 'lose':
        targetCalories = tdee - 500; // Déficit de 500 kcal
        const weightToLose = Math.abs(parseFloat(weight) - parseFloat(targetWeight));
        estimatedWeeks = Math.ceil((weightToLose * 7700) / (500 * 7)); // 1kg = 7700 kcal
        break;
      case 'gain':
        targetCalories = tdee + 300; // Superávit de 300 kcal
        const weightToGain = Math.abs(parseFloat(targetWeight) - parseFloat(weight));
        estimatedWeeks = Math.ceil(weightToGain * 4); // ~0.25kg por semana
        break;
      case 'maintain':
        targetCalories = tdee;
        estimatedWeeks = null;
        break;
      default:
        targetCalories = tdee;
        estimatedWeeks = null;
    }

    // Distribuição de macronutrientes
    const protein = Math.round(parseFloat(weight) * 2); // 2g por kg
    const fats = Math.round(targetCalories * 0.25 / 9); // 25% das calorias
    const carbs = Math.round((targetCalories - (protein * 4) - (fats * 9)) / 4);

    // Água (35ml por kg de peso)
    const waterML = Math.round(parseFloat(weight) * 35);

    // Plano gerado
    const plan = {
      user: {
        name,
        age: parseInt(age),
        gender,
        currentWeight: parseFloat(weight),
        targetWeight: parseFloat(targetWeight),
        height: parseFloat(height),
        goal,
        activityLevel
      },
      nutrition: {
        dailyCalories: Math.round(targetCalories),
        protein: `${protein}g`,
        carbs: `${carbs}g`,
        fats: `${fats}g`,
        water: `${(waterML / 1000).toFixed(1)}L`
      },
      timeline: {
        estimatedWeeks: estimatedWeeks,
        estimatedMonths: estimatedWeeks ? Math.ceil(estimatedWeeks / 4) : null
      },
      recommendations: generateRecommendations(goal, activityLevel, dietType)
    };

    res.json({ success: true, plan });

  } catch (error) {
    console.error('Erro ao calcular plano:', error);
    res.status(500).json({ error: 'Erro ao processar os dados' });
  }
});

// ========================================
// 💳 STRIPE - CRIAR CHECKOUT SESSION
// ========================================

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { planType, userEmail, userName } = req.body;

    // Preços dos planos (em centavos)
    const prices = {
      monthly: {
        amount: 2990, // R$ 29,90
        interval: 'month'
      },
      quarterly: {
        amount: 7990, // R$ 79,90
        interval: 'month',
        intervalCount: 3
      },
      annual: {
        amount: 19990, // R$ 199,90
        interval: 'year'
      }
    };

    const selectedPrice = prices[planType];

    if (!selectedPrice) {
      return res.status(400).json({ error: 'Plano inválido' });
    }

    // Criar sessão de checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: userEmail,
      client_reference_id: userName,
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: `NutriIA - Plano ${planType === 'monthly' ? 'Mensal' : planType === 'quarterly' ? 'Trimestral' : 'Anual'}`,
              description: 'Acesso completo ao seu plano nutricional personalizado',
              images: ['https://i.imgur.com/YOUR_LOGO.png'], // Adicione seu logo aqui
            },
            unit_amount: selectedPrice.amount,
            recurring: {
              interval: selectedPrice.interval,
              interval_count: selectedPrice.intervalCount || 1
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/plans`,
      metadata: {
        planType,
        userName
      }
    });

    res.json({ sessionId: session.id, url: session.url });

  } catch (error) {
    console.error('Erro ao criar checkout:', error);
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento' });
  }
});

// ========================================
// 🔔 STRIPE WEBHOOK
// ========================================

app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Processar eventos
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('✅ Pagamento concluído:', session.customer_email);
      // Aqui você pode: ativar conta, enviar email, salvar no banco de dados
      break;

    case 'customer.subscription.created':
      console.log('✅ Assinatura criada');
      break;

    case 'customer.subscription.deleted':
      console.log('❌ Assinatura cancelada');
      // Desativar acesso do usuário
      break;

    case 'invoice.payment_failed':
      console.log('⚠️  Falha no pagamento');
      // Enviar email de aviso
      break;

    default:
      console.log(`Evento não tratado: ${event.type}`);
  }

  res.json({ received: true });
});

// ========================================
// 📊 VERIFICAR STATUS DA ASSINATURA
// ========================================

app.get('/api/subscription-status/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length > 0) {
      res.json({ 
        active: true, 
        subscription: subscriptions.data[0] 
      });
    } else {
      res.json({ active: false });
    }

  } catch (error) {
    console.error('Erro ao verificar assinatura:', error);
    res.status(500).json({ error: 'Erro ao verificar status' });
  }
});

// ========================================
// 🎯 FUNÇÃO AUXILIAR: GERAR RECOMENDAÇÕES
// ========================================

function generateRecommendations(goal, activityLevel, dietType) {
  const recommendations = {
    meals: [],
    exercises: [],
    tips: []
  };

  // Recomendações de refeições baseadas no objetivo
  if (goal === 'lose') {
    recommendations.meals = [
      'Café da manhã: Ovos mexidos + aveia + frutas vermelhas',
      'Lanche: Iogurte natural com granola',
      'Almoço: Frango grelhado + arroz integral + brócolis',
      'Lanche: Mix de castanhas (30g)',
      'Jantar: Salmão + batata doce + salada verde'
    ];
    recommendations.tips = [
      'Beba 2-3L de água por dia',
      'Evite alimentos processados e açúcar refinado',
      'Faça exercícios 4-5x por semana',
      'Durma 7-8 horas por noite'
    ];
  } else if (goal === 'gain') {
    recommendations.meals = [
      'Café da manhã: Panqueca de banana + pasta de amendoim',
      'Lanche: Vitamina de whey + banana + aveia',
      'Almoço: Carne vermelha magra + arroz + feijão + batata',
      'Lanche: Sanduíche natural de atum',
      'Jantar: Frango + macarrão integral + azeite'
    ];
    recommendations.tips = [
      'Faça 5-6 refeições por dia',
      'Priorize alimentos calóricos e nutritivos',
      'Treine com pesos 4-5x por semana',
      'Descanse adequadamente entre treinos'
    ];
  } else {
    recommendations.meals = [
      'Mantenha uma dieta balanceada',
      'Varie os alimentos para obter todos os nutrientes',
      'Coma proteínas em todas as refeições'
    ];
  }

  return recommendations;
}

// ========================================
// 🚀 INICIAR SERVIDOR
// ========================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   🚀 NutriIA Backend Server         ║
║   📡 Porta: ${PORT}                    ║
║   🌍 Ambiente: ${process.env.NODE_ENV || 'development'}        ║
║   ✅ Servidor rodando com sucesso!   ║
╚══════════════════════════════════════╝
  `);
  console.log(`📝 Webhook URL: http://localhost:${PORT}/webhook/stripe`);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (err) => {
  console.error('❌ Erro não tratado:', err);
});